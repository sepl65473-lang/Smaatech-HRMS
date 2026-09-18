// Pure Express app construction — no .listen(), no DB connection, no
// background jobs. Split out from index.js so tests (and any other future
// caller) can import a real, fully-wired `app` and drive it with supertest
// without booting the actual server process or its side effects.
import express from 'express';
import { randomUUID } from 'node:crypto';
import 'express-async-errors';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger.js';
import logger from './lib/logger.js';
import { warnIfE2EEnabled } from './lib/e2eGuard.js';
import {
  apiLimiter, ipCeilingLimiter,
  loginIpLimiter, loginBurstLimiter, loginAccountLimiter,
  faceUserLimiter, faceIpLimiter, attendanceUserLimiter, financialUserLimiter,
} from './middleware/rateLimits.js';
import authRoutes from './routes/auth.js';
import employeesRoutes from './routes/employees.js';
import usersRoutes from './routes/users.js';
import attendanceRoutes from './routes/attendance.js';
import settingsRoutes from './routes/settings.js';
import faceRoutes from './routes/face.js';
import filesRoutes from './routes/files.js';
import leaveRoutes from './routes/leave.js';
import payrollRoutes from './routes/payroll.js';
import holidaysRoutes from './routes/holidays.js';
import recruitmentRoutes from './routes/recruitment.js';
import reviewsRoutes from './routes/reviews.js';
import expensesRoutes from './routes/expenses.js';
import assetsRoutes from './routes/assets.js';
import jobsRoutes from './routes/jobs.js';
import celebrationsRoutes from './routes/celebrations.js';
import rolesRoutes from './routes/roles.js';
import masterDataRoutes from './routes/masterData.js';
import auditLogsRoutes from './routes/auditLogs.js';
import notificationsRoutes from './routes/notifications.js';
import documentsRoutes from './routes/documents.js';
import resignationsRoutes from './routes/resignations.js';
import attendanceCorrectionsRoutes from './routes/attendanceCorrections.js';
import deviceIngestRoutes from './routes/deviceIngest.js';
import deviceMappingsRoutes from './routes/deviceMappings.js';
import healthRoutes from './routes/health.js';
import aiPredictorRoutes from './routes/aiPredictorRoutes.js';
import analyticsRoutes from './routes/analytics.js';
import lifecycleRoutes from './routes/lifecycle.js';
import payComponentsRoutes from './routes/payComponents.js';

warnIfE2EEnabled();

const app = express();

// Behind Vercel/Render/an nginx front, every request arrives from the proxy's
// own address. Without this, req.ip is the PROXY for all traffic — which means
// express-rate-limit buckets the entire internet into one counter (300
// req/15min shared by every user, a self-inflicted outage) and every audit-log
// and refresh-token row records the proxy's IP instead of the client's. A
// specific hop count rather than `true`: blanket trust lets a client forge
// X-Forwarded-For and evade per-IP limits entirely.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Give every request an id, echoed back and attached for logging, so a user
// reporting "it failed at 14:32" can be traced to exact server-side lines.
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming)) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Security Middleware
//
// CSP was previously switched OFF across the whole API ("for flexibility /
// Swagger UI"). That traded a real header away for one route's convenience.
// This API does serve browser-reachable responses — attendance selfies inline
// (routes/files.js) and document downloads (routes/documents.js) — so a
// response served from this origin can end up as a top-level document. A
// strict policy here is defence-in-depth for exactly that case, and costs
// nothing for JSON.
//
// 'none' everywhere is correct for an API: no scripts, no styles, no frames,
// no form posts, no base-tag rewriting. Swagger UI genuinely needs inline
// script and style, so it gets its own relaxed policy on its own path below
// rather than every endpoint inheriting the loosest one.
const API_CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'none'"],
  styleSrc: ["'none'"],
  imgSrc: ["'none'"],
  connectSrc: ["'none'"],
  fontSrc: ["'none'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
};

app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: API_CSP_DIRECTIVES } }));

// Swagger UI ships inline bootstrap script and inline styles, so it cannot run
// under the API policy above. Scoped to this one path, and it is the docs page
// only — no application data is rendered here.
const swaggerCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'", 'data:'],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
  },
});
app.use(mongoSanitize());
app.use(compression());

// CORS must be registered before the rate limiters below — express-rate-limit
// ends the response itself once a client is over its limit, so any
// middleware registered after it (this included) never runs for that
// response. Without CORS headers on a rate-limited response, the browser
// can't read it at all and the app sees a bare, misleading "Network Error"
// instead of the actual "too many requests" message — indistinguishable
// from the server being unreachable.
const stripSlash = (value) => String(value).replace(/\/$/, '');

// CLIENT_ORIGIN accepts a comma-separated list so a staging and a production
// frontend can share one API deployment.
const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .map(stripSlash);

const isDevEnv = process.env.NODE_ENV !== 'production';
const allowedOrigins = [
  ...(isDevEnv ? ['http://localhost:5173', 'http://localhost:3000'] : []),
  ...configuredOrigins,
];

// Vercel preview deployments get URLs like
// <project>-<hash>-<team>.vercel.app, so a preview build genuinely needs a
// pattern rather than a fixed string. The old pattern was /\.vercel\.app$/ —
// which matched EVERY app anyone has ever deployed to vercel.app, and paired
// with credentials:true that let any attacker's Vercel page make authenticated
// cross-origin calls against this API on a logged-in user's behalf. Scoped to
// this project's own prefix, and only when explicitly opted into.
const previewPrefix = process.env.VERCEL_PREVIEW_PREFIX;

// Plain string checks rather than a built regex: the prefix is operator-
// supplied config, and a stray regex metacharacter in it would quietly widen
// what this matches — exactly the failure mode being fixed here.
function isProjectPreviewOrigin(origin) {
  if (!previewPrefix) return false;
  if (!origin.startsWith('https://')) return false;
  const host = origin.slice('https://'.length);
  if (!host.endsWith('.vercel.app')) return false;
  if (host.includes('/')) return false;
  const label = host.slice(0, -'.vercel.app'.length);
  return label === previewPrefix || label.startsWith(`${previewPrefix}-`);
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / server-to-server / curl
  const normalized = stripSlash(origin);
  if (allowedOrigins.includes(normalized)) return true;
  return isProjectPreviewOrigin(normalized);
}

export { isAllowedOrigin };

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
  maxAge: 600,
}));

// Rate limiting lives in middleware/rateLimits.js. It is LAYERED rather than
// purely per-IP, because 100 employees behind one office NAT previously shared
// a single 10-login bucket. See that file for the full rationale.
//
// ORDER MATTERS HERE:
//   - the IP ceiling and the general API limiter need no request body, so they
//     run first and shed abusive load before anything is parsed;
//   - the per-ACCOUNT login limiter keys on the submitted email, so it must run
//     AFTER express.json(). Registering it earlier silently fell back to the IP
//     key and provided no account-level protection at all.
app.use('/api/', ipCeilingLimiter);
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Login: three independent layers - sustained per-network volume, a short
// per-network burst, and per-account attempts that no amount of IP rotation
// can dilute.
const loginPaths = ['/api/v1/auth/login', '/api/v1/auth/face-login'];
for (const path of loginPaths) {
  app.use(path, loginIpLimiter, loginBurstLimiter, loginAccountLimiter);
}
app.use('/api/v1/auth/forgot-password', loginIpLimiter, loginAccountLimiter);
app.use('/api/v1/auth/reset-password', loginIpLimiter, loginAccountLimiter);

// Expensive, CPU-bound routes get their own per-user cap plus an IP backstop.
app.use('/api/v1/face', faceUserLimiter, faceIpLimiter);
app.use('/api/v1/attendance', attendanceUserLimiter);
app.use('/api/v1/resignations/:id/fnf/pay', financialUserLimiter);

// Swagger API Documentation Endpoint
app.use('/api-docs', swaggerCsp, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API V1 Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/employees', employeesRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/face', faceRoutes);
app.use('/api/v1/files', filesRoutes);
app.use('/api/v1/leaves', leaveRoutes);
app.use('/api/v1/payroll', payrollRoutes);
app.use('/api/v1/holidays', holidaysRoutes);
app.use('/api/v1/recruitment', recruitmentRoutes);
app.use('/api/v1/reviews', reviewsRoutes);
app.use('/api/v1/expenses', expensesRoutes);
app.use('/api/v1/assets', assetsRoutes);
app.use('/api/v1/jobs', jobsRoutes);
app.use('/api/v1/celebrations', celebrationsRoutes);
app.use('/api/v1/roles', rolesRoutes);
app.use('/api/v1/master-data', masterDataRoutes);
app.use('/api/v1/audit-logs', auditLogsRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/documents', documentsRoutes);
app.use('/api/v1/resignations', resignationsRoutes);
app.use('/api/v1/attendance-corrections', attendanceCorrectionsRoutes);
// Not nested under /attendance — a physical device has no user JWT, so this
// must sit outside that router's router.use(requireAuth).
app.use('/api/v1/device-punch', deviceIngestRoutes);
app.use('/api/v1/device-mappings', deviceMappingsRoutes);
app.use('/api/v1', healthRoutes);
app.use('/api/v1/ai', aiPredictorRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/lifecycle', lifecycleRoutes);
app.use('/api/v1/pay-components', payComponentsRoutes);

// Unknown API routes get a JSON 404, not Express's default HTML page — a
// client parsing every response as JSON otherwise sees an opaque parse error
// instead of "that endpoint does not exist".
app.use('/api', (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}` },
    requestId: req.id,
  });
});

// Error Handling Middleware
app.use((err, req, res, _next) => {
  // A body-parser failure (malformed JSON, oversized payload) is a client
  // error; returning 500 for it both misleads the caller and pollutes error
  // rate alerting with traffic the server handled correctly.
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' }, requestId: req.id });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' }, requestId: req.id });
  }
  if (err?.name === 'ValidationError') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message }, requestId: req.id });
  }
  if (err?.name === 'CastError') {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Malformed identifier.' }, requestId: req.id });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'That record already exists.' }, requestId: req.id });
  }

  logger.error('[Express Error Handler] requestId=%s %o', req.id, err);
  // The message is deliberately generic — an internal error string can carry
  // connection URIs, collection names and stack detail. requestId is what ties
  // the user's report to the full logged error.
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' }, requestId: req.id });
});

export default app;
