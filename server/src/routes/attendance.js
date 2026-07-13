import { Router } from 'express';
import multer from 'multer';
import Attendance from '../models/Attendance.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { evaluateGeofence } from '../lib/geofence.js';
import { resolveShiftForToday, isLate, isEarlyExit, nowTimeIST } from '../lib/shifts.js';
import { parseDeviceInfo, clientIp } from '../lib/deviceInfo.js';
import { reverseGeocode } from '../lib/geocode.js';
import { extractDescriptor, matchDescriptor } from '../lib/faceEngine.js';
import { savePhoto } from '../lib/photoStorage.js';
import { getSettingsDoc } from './settings.js';

const SHARED_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Buddy-punching signal: the same physical device checking in for two
// different employees within a short window. A flag for HR review, not a
// hard block — a shared reception device is a legitimate case too.
async function findSharedDeviceFlag(deviceId, empId, rowId) {
  if (!deviceId) return null;
  const since = new Date(Date.now() - SHARED_DEVICE_WINDOW_MS);
  const other = await Attendance.findOne({
    _id: { $ne: rowId },
    empId: { $ne: empId },
    createdAt: { $gte: since },
    $or: [{ checkInDeviceId: deviceId }, { checkOutDeviceId: deviceId }],
  });
  return other ? 'shared-device' : null;
}

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

function gpsFailureMessage(result) {
  switch (result.reason) {
    case 'NO_COORDINATES': return 'Location is required for check-in but none was received.';
    case 'LOW_ACCURACY': return `GPS reading too imprecise (±${Math.round(result.accuracy)}m) to verify your location.`;
    case 'STALE_FIX': return 'Location reading is too old, please try again.';
    case 'OUTSIDE_GEOFENCE': return `You're ${Math.round(result.distance)}m from the office — outside the allowed radius.`;
    default: return 'Location verification failed.';
  }
}

function faceFailureMessage(code) {
  switch (code) {
    case 'NOT_ENROLLED': return 'Face not enrolled yet — enroll your face before checking in.';
    case 'NO_FACE': return 'No face detected in the photo — try again with better lighting, facing the camera directly.';
    case 'MULTIPLE_FACES': return 'More than one face detected — make sure only you are in frame.';
    case 'FACE_NOT_MATCHED': return "That doesn't match your enrolled face.";
    case 'NO_PHOTO': return 'A photo is required to check in.';
    default: return 'Face verification failed.';
  }
}

// ── Self check-in / check-out — the actually-guarded path ──────────────────
// Every fact used to decide the outcome (geofence distance, face match,
// shift/lateness, server clock) is re-derived here from data the server
// itself holds. For self-service, the uploaded photo is re-detected and
// re-matched against the enrolled descriptor server-side — a forged client
// can lie about a "faceVerified" flag, but not about what this server's own
// model sees in the photo it uploaded.
async function handlePunch(req, res, direction) {
  const row = await Attendance.findById(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwnRow = req.auth.employeeId === String(row.empId);
  if (!isAdmin && !isOwnRow) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only check yourself in or out.' } });
  }
  // Geofence/face verification only applies to genuine self-service
  // check-ins — an HR override from the Attendance roster is a trusted
  // manual action (same as before this project's fraud-hardening work) and
  // must keep working unconditionally.
  const isSelfService = !isAdmin;

  const settings = await getSettingsDoc();
  const lat = req.body.lat != null ? Number(req.body.lat) : null;
  const lng = req.body.lng != null ? Number(req.body.lng) : null;
  const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;
  const timestamp = req.body.timestamp != null ? Number(req.body.timestamp) : null;
  const deviceId = req.body.deviceId || null;

  let gpsResult = null;
  if (settings.gpsCheckInEnabled && isSelfService) {
    gpsResult = evaluateGeofence({ lat, lng, accuracy, timestamp }, settings);
    if (!gpsResult.ok) {
      return res.status(400).json({ error: { code: gpsResult.reason, message: gpsFailureMessage(gpsResult) } });
    }
  }

  let faceResult = null;
  let photoBuffer = null;
  if (isSelfService) {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'NO_PHOTO', message: faceFailureMessage('NO_PHOTO') } });
    }
    photoBuffer = req.file.buffer;

    const enrolled = await FaceDescriptor.findOne({ userId: req.auth.sub });
    if (!enrolled) {
      return res.status(400).json({ error: { code: 'NOT_ENROLLED', message: faceFailureMessage('NOT_ENROLLED') } });
    }
    const extraction = await extractDescriptor(photoBuffer);
    if (extraction.error) {
      return res.status(400).json({ error: { code: extraction.error, message: faceFailureMessage(extraction.error) } });
    }
    const match = matchDescriptor(extraction.descriptor, enrolled.descriptor);
    if (!match.matched) {
      return res.status(400).json({ error: { code: 'FACE_NOT_MATCHED', message: faceFailureMessage('FACE_NOT_MATCHED') } });
    }
    faceResult = match;
  }

  const time = nowTimeIST();
  const hasGps = gpsResult?.inside;
  const details = faceResult
    ? (hasGps ? 'Face + GPS Verified' : 'Face Verified')
    : (hasGps ? 'GPS Verified' : null);
  const verification = {
    face: faceResult ? { matched: true, confidence: Math.round(faceResult.confidence), distance: faceResult.distance } : null,
    gps: gpsResult,
    verifiedAt: new Date().toISOString(),
  };

  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);
  const address = hasGps ? await reverseGeocode(lat, lng) : null;
  const sharedDeviceFlag = isSelfService ? await findSharedDeviceFlag(deviceId, row.empId, row._id) : null;
  const anomalyFlags = sharedDeviceFlag
    ? [...new Set([...(row.anomalyFlags || []), sharedDeviceFlag])]
    : row.anomalyFlags;

  const photoRef = photoBuffer
    ? savePhoto(`attendance/${row.empId}`, `${Date.now()}-${direction}.jpg`, photoBuffer)
    : null;

  const shift = resolveShiftForToday(String(row.empId), settings);
  const patch = direction === 'in'
    ? {
        checkIn: time,
        status: isLate(time, shift) ? 'late' : 'present',
        checkInLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkInAddress: address,
        checkInDetails: details,
        checkInVerification: verification,
        checkInAccuracy: accuracy,
        checkInDeviceId: deviceId,
        checkInDevice: device,
        checkInIp: ip,
        checkInPhotoRef: photoRef,
        checkInFaceConfidence: faceResult ? Math.round(faceResult.confidence) : null,
        anomalyFlags,
      }
    : {
        checkOut: time,
        status: isEarlyExit(time, shift) ? 'early-exit' : row.status,
        checkOutLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkOutAddress: address,
        checkOutDetails: details,
        checkOutVerification: verification,
        checkOutAccuracy: accuracy,
        checkOutDeviceId: deviceId,
        checkOutDevice: device,
        checkOutIp: ip,
        checkOutPhotoRef: photoRef,
        checkOutFaceConfidence: faceResult ? Math.round(faceResult.confidence) : null,
        anomalyFlags,
      };

  const updated = await Attendance.findByIdAndUpdate(req.params.id, patch, { new: true });
  res.json(updated);
}

router.post('/:id/check-in', upload.single('photo'), (req, res) => handlePunch(req, res, 'in'));
router.post('/:id/check-out', upload.single('photo'), (req, res) => handlePunch(req, res, 'out'));

export default router;
