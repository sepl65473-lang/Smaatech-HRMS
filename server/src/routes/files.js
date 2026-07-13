import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import { requireAuth } from '../middleware/auth.js';
import { readPhoto } from '../lib/photoStorage.js';

const router = Router();
router.use(requireAuth);

// Attendance selfies are biometric-adjacent personal photos — never served
// as static files. Only the employee themself or HR Manager/Director may
// view one, and only via this authenticated, per-record check.
router.get('/attendance/:attendanceId/:which', async (req, res) => {
  const { attendanceId, which } = req.params;
  if (which !== 'checkIn' && which !== 'checkOut') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'which must be checkIn or checkOut.' } });
  }
  const row = await Attendance.findById(attendanceId);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwnRow = req.auth.employeeId === String(row.empId);
  if (!isAdmin && !isOwnRow) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed to view this photo.' } });
  }

  const ref = which === 'checkIn' ? row.checkInPhotoRef : row.checkOutPhotoRef;
  if (!ref) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No photo on file for this record.' } });

  const buffer = readPhoto(ref);
  if (!buffer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo file missing.' } });

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(buffer);
});

export default router;
