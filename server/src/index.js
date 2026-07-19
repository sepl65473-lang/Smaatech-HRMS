import 'dotenv/config';
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
import { connectDB } from './db.js';
import { initFaceEngine } from './lib/faceEngine.js';
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
import { startDocumentExpiryScheduler } from './lib/documentExpiryJob.js';

process.on('unhandledRejection', (err) => {
  logger.error('[server] unhandled rejection: %o', err);
});
process.on('uncaughtException', (err) => {
  logger.error('[server] uncaught exception: %o', err);
});

const app = express();

// Security Middleware
app.use(helmet({ contentSecurityPolicy: false })); // Disable CSP for API flexibility / Swagger UI
app.use(mongoSanitize());
app.use(compression());

// Rate Limiter: max 300 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later.' } }
});
app.use('/api/', apiLimiter);

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
      callback(null, true);
    }
  },
  credentials: true,
}));
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

// Error Handling Middleware
app.use((err, _req, res, _next) => {
  logger.error('[Express Error Handler] %o', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[server] listening on 0.0.0.0:${PORT}`);
  logger.info(`[server] Swagger API documentation available at http://localhost:${PORT}/api-docs`);
  
  connectDB().catch((err) => {
    logger.error('[db] connection failed: %s', err.message);
  });

  initFaceEngine().catch((err) => {
    logger.warn('[face] engine init deferred: %s', err.message);
  });

  try {
    startDocumentExpiryScheduler();
  } catch (err) {
    logger.warn('[scheduler] deferred: %s', err.message);
  }
});

