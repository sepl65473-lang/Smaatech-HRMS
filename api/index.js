import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import { connectDB } from '../server/src/db.js';

import authRoutes from '../server/src/routes/auth.js';
import employeesRoutes from '../server/src/routes/employees.js';
import usersRoutes from '../server/src/routes/users.js';
import attendanceRoutes from '../server/src/routes/attendance.js';
import settingsRoutes from '../server/src/routes/settings.js';
import filesRoutes from '../server/src/routes/files.js';
import leaveRoutes from '../server/src/routes/leave.js';
import payrollRoutes from '../server/src/routes/payroll.js';
import holidaysRoutes from '../server/src/routes/holidays.js';
import recruitmentRoutes from '../server/src/routes/recruitment.js';
import reviewsRoutes from '../server/src/routes/reviews.js';
import expensesRoutes from '../server/src/routes/expenses.js';
import assetsRoutes from '../server/src/routes/assets.js';
import jobsRoutes from '../server/src/routes/jobs.js';
import celebrationsRoutes from '../server/src/routes/celebrations.js';
import rolesRoutes from '../server/src/routes/roles.js';
import masterDataRoutes from '../server/src/routes/masterData.js';
import auditLogsRoutes from '../server/src/routes/auditLogs.js';
import notificationsRoutes from '../server/src/routes/notifications.js';
import documentsRoutes from '../server/src/routes/documents.js';
import resignationsRoutes from '../server/src/routes/resignations.js';
import attendanceCorrectionsRoutes from '../server/src/routes/attendanceCorrections.js';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(mongoSanitize());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Connect DB middleware for serverless execution — required secrets must
// come from Vercel's own Environment Variables, never a hardcoded fallback
// (a fallback here would mean anyone who can read this source file could
// forge a valid login token or connect to the database directly).
app.use(async (req, res, next) => {
  const missing = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']
    .filter((key) => !process.env[key]);
  if (missing.length) {
    return res.status(500).json({
      error: {
        code: 'MISSING_CONFIG',
        message: `Server misconfigured: missing ${missing.join(', ')}. Set these in Vercel's Environment Variables.`,
      },
    });
  }
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

// V1 API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/employees', employeesRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/settings', settingsRoutes);
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

// Error Handler
app.use((err, _req, res, _next) => {
  console.error('[Serverless API Error]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Something went wrong.' } });
});

export default app;
