// Pure Express app construction — no .listen(), no DB connection, no
// background jobs. Split out from index.js so tests (and any other future
// caller) can import a real, fully-wired `app` and drive it with supertest
// without booting the actual server process or its side effects.
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger.js';
import logger from './lib/logger.js';
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

const app = express();

// Security Middleware
app.use(helmet({ contentSecurityPolicy: false })); // Disable CSP for API flexibility / Swagger UI
app.use(mongoSanitize());
app.use(compression());

// CORS must be registered before the rate limiters below — express-rate-limit
// ends the response itself once a client is over its limit, so any
// middleware registered after it (this included) never runs for that
// response. Without CORS headers on a rate-limited response, the browser
// can't read it at all and the app sees a bare, misleading "Network Error"
// instead of the actual "too many requests" message — indistinguishable
// from the server being unreachable.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.replace(/\/$/, '') : null,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, '')) || /\.vercel\.app$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));

// Rate Limiters
const isTestEnv = process.env.NODE_ENV === 'test';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later.' } }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many authentication attempts. Please try again in 15 minutes.' } }
});

const financialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many transaction requests. Please try again later.' } }
});

app.use('/api/', apiLimiter);
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/verify-2fa', authLimiter);
app.use('/api/v1/auth/forgot-password', authLimiter);
app.use('/api/v1/auth/reset-password', authLimiter);
app.use('/api/v1/resignations/:id/fnf/pay', financialLimiter);

app.use(express.json());
app.use(cookieParser());

// Swagger API Documentation Endpoint
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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

// Error Handling Middleware
app.use((err, _req, res, _next) => {
  logger.error('[Express Error Handler] %o', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
});

export default app;
