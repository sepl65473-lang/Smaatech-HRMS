import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { evaluateGeofence } from '../lib/geofence.js';
import { resolveShiftForToday, isLate, nowTimeIST } from '../lib/shifts.js';
import { getSettingsDoc } from './settings.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Attendance.find().sort({ createdAt: 1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Attendance.findById(req.params.id);
  res.json(row || null);
});

// Generic CRUD below is the HR-override surface (Attendance.jsx roster table,
// leave-approval side effects, employee add/remove cascades) — trusted callers
// only, gated by role. Self check-in/out has its own verified path further down.
router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Attendance.create(req.body || {});
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Attendance.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Attendance.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

// ── Self check-in / check-out — the actually-guarded path ──────────────────
// Every fact used to decide the outcome (geofence distance, shift/lateness,
// server clock) is re-derived here from data the server itself holds; the
// client's coordinates are the only untrusted input, and even those are
// independently re-measured against the server's own geofence config.
async function handlePunch(req, res, direction) {
  const row = await Attendance.findById(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwnRow = req.auth.employeeId === String(row.empId);
  if (!isAdmin && !isOwnRow) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only check yourself in or out.' } });
  }
  // Geofence/liveness-adjacent verification only applies to genuine
  // self-service check-ins — an HR override from the Attendance roster is a
  // trusted manual action (same as before this project's fraud-hardening
  // work) and must keep working unconditionally, GPS enforcement or not.
  const isSelfService = !isAdmin;

  const settings = await getSettingsDoc();
  const { lat, lng, accuracy, timestamp, faceVerified, qrVerified } = req.body || {};

  let gpsResult = null;
  if (settings.gpsCheckInEnabled && isSelfService) {
    gpsResult = evaluateGeofence({ lat, lng, accuracy, timestamp }, settings);
    if (!gpsResult.ok) {
      return res.status(400).json({
        error: { code: gpsResult.reason, message: gpsFailureMessage(gpsResult) },
      });
    }
  }

  const time = nowTimeIST();
  const hasGps = gpsResult?.inside;
  const details = faceVerified
    ? (hasGps ? 'Face + GPS Verified' : 'Face Verified')
    : qrVerified
      ? 'QR Verified'
      : (hasGps ? 'GPS Verified' : null);
  const verification = {
    face: { claimed: Boolean(faceVerified) },
    qr: { claimed: Boolean(qrVerified) },
    gps: gpsResult,
    verifiedAt: new Date().toISOString(),
  };

  const patch = direction === 'in'
    ? {
        checkIn: time,
        status: isLate(time, resolveShiftForToday(String(row.empId), settings)) ? 'late' : 'present',
        checkInLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkInDetails: details,
        checkInVerification: verification,
      }
    : {
        checkOut: time,
        checkOutLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkOutDetails: details,
        checkOutVerification: verification,
      };

  const updated = await Attendance.findByIdAndUpdate(req.params.id, patch, { new: true });
  res.json(updated);
}

function gpsFailureMessage(result) {
  switch (result.reason) {
    case 'NO_COORDINATES': return 'Location is required for check-in but none was received.';
    case 'LOW_ACCURACY': return `GPS reading too imprecise (±${Math.round(result.accuracy)}m) to verify your location.`;
    case 'STALE_FIX': return 'Location reading is too old, please try again.';
    case 'OUTSIDE_GEOFENCE': return `You're ${Math.round(result.distance)}m from the office — outside the allowed radius.`;
    default: return 'Location verification failed.';
  }
}

router.post('/:id/check-in', (req, res) => handlePunch(req, res, 'in'));
router.post('/:id/check-out', (req, res) => handlePunch(req, res, 'out'));

export default router;
