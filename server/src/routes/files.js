import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { readPhoto, contentTypeForRef } from '../lib/photoStorage.js';
import { attendancePhotoExpiry } from '../lib/attendancePhotoExpiry.js';
import VerificationAttempt from '../models/VerificationAttempt.js';

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
  const row = await Attendance.findOne({ _id: attendanceId, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwnRow = req.auth.employeeId === String(row.empId);
  if (!isAdmin && !isOwnRow) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed to view this photo.' } });
  }

  const ref = which === 'checkIn' ? row.checkInPhotoRef : row.checkOutPhotoRef;
  if (!ref) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No photo on file for this record.' } });

  // An attendance photo is kept for 24 hours. Past that it is not served,
  // whether or not the cleanup job has reached it yet.
  const expiresAt = await attendancePhotoExpiry(ref);
  const secondsLeft = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 1000) : null;
  if (secondsLeft !== null && secondsLeft <= 0) {
    return res.status(410).json({ error: { code: 'PHOTO_EXPIRED', message: 'This attendance photo was deleted automatically 24 hours after it was taken.' } });
  }

  const buffer = await readPhoto(ref);
  if (!buffer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo file missing.' } });

  res.setHeader('Content-Type', 'image/jpeg');
  // Never cached in the browser beyond the photo's own expiry.
  res.setHeader('Cache-Control', `private, max-age=${secondsLeft === null ? 3600 : Math.min(3600, secondsLeft)}`);
  res.send(buffer);
});

// A REJECTED verification capture — the evidence behind "someone signed in
// with valid credentials and presented a face that was not theirs".
//
// HR Manager / HR Director only. Deliberately NOT visible to the employee the
// attempt was made against: if the attempt was an impersonation, the person
// whose account was targeted is not automatically entitled to the would-be
// impersonator's photograph, and if it was their own failed capture the image
// tells them nothing they don't know. HR adjudicates.
router.get('/verification-attempt/:attemptId', async (req, res) => {
  const isHR = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed to view verification evidence.' } });
  }

  const attempt = await VerificationAttempt.findOne({
    _id: req.params.attemptId,
    ...companyFilter(req),
  });
  if (!attempt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Verification attempt not found.' } });
  if (!attempt.photoRef) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No photo was captured for this attempt.' } });
  }

  const buffer = await readPhoto(attempt.photoRef);
  if (!buffer) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo file missing.' } });

  res.setHeader('Content-Type', contentTypeForRef(attempt.photoRef));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Biometric evidence: never cached by a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

export default router;
