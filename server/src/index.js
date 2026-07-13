import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDB } from './db.js';
import { initFaceEngine } from './lib/faceEngine.js';
import authRoutes from './routes/auth.js';
import employeesRoutes from './routes/employees.js';
import attendanceRoutes from './routes/attendance.js';
import settingsRoutes from './routes/settings.js';
import faceRoutes from './routes/face.js';
import filesRoutes from './routes/files.js';

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/employees', employeesRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/face', faceRoutes);
app.use('/api/v1/files', filesRoutes);

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
