import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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

// Route handlers here are bare `async (req, res) => {...}` with no
// try/catch, and Express 4 doesn't forward a rejected handler promise to the
// error middleware below on its own — so an unhandled rejection (e.g. a
// Mongoose CastError from a malformed :id) reaches Node directly, which by
// default terminates the whole process. That took the entire server down
// once already; log-and-continue instead of crashing on every request.
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
});

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());

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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
});

const PORT = process.env.PORT || 4000;

Promise.all([connectDB(), initFaceEngine()]).then(() => {
  app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('[server] failed to start:', err.message);
  process.exit(1);
});
