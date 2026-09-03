import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { evaluateGeofence } from '../lib/geofence.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay, nowTimeIST } from '../lib/shifts.js';
import { parseDeviceInfo, clientIp } from '../lib/deviceInfo.js';
import { reverseGeocode } from '../lib/geocode.js';
import { extractDescriptor, matchDescriptor, faceFailureMessage } from '../lib/faceEngine.js';
import { savePhoto, imageUploadMiddleware } from '../lib/photoStorage.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import { todayISO, isoDateDaysAgo } from '../lib/dateUtils.js';
import { notifyAttendanceEvent } from '../lib/attendanceNotify.js';
import { issueQrToken, consumeQrToken } from '../lib/qrTokenStore.js';

const RANGE_TO_DAYS = { Week: 7, Month: 30, Quarter: 90 };

const SHARED_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const upload = imageUploadMiddleware('photo', 'Check-in photo must be a JPEG, PNG, or WebP image.');

// Client-settable roster fields for the HR-override PATCH — photo refs,
// company, and empId are always server-computed/scoped and must never come
// straight from the request body (that was the source of an earlier
// mass-assignment bug letting a caller point checkInPhotoRef/company at
// arbitrary values).
const ALLOWED_ATTENDANCE_FIELDS = ['name', 'dept', 'status', 'checkIn', 'checkOut'];

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

router.get('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const scope = { ...companyFilter(req), ...(isManager ? {} : { empId: req.auth.employeeId }) };
  const { page, limit, date, from, to } = req.query;

  // Legacy callers (loadAll()'s initial hydrate, Dashboard's direct array
  // consumption) get the same unpaginated full-array shape as before —
  // nothing downstream of those expects pagination. Only opt into
  // paging/filtering when a caller explicitly asks for it (same convention
  // as GET /audit-logs).
  if (!page && !limit) {
    const rows = await Attendance.find(scope).sort({ createdAt: 1 });
    return res.json(rows);
  }

  const filter = { ...scope };
  if (date) {
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Attendance.find(filter).sort({ date: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Attendance.countDocuments(filter),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
});

// Real per-department present/late/absent totals over a date range — feeds
// Dashboard.jsx's AttendanceChart, replacing the old client-side fake
// multiplier (RANGE_FACTOR/rangeVariance) now that real daily history exists.
// Registered before /:id so "summary" is never captured as an :id param.
router.get('/summary', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const scope = { ...companyFilter(req), ...(isManager ? {} : { empId: req.auth.employeeId }) };

  const { range, from, to } = req.query;
  const dateTo = to || todayISO();
  const dateFrom = from || isoDateDaysAgo(RANGE_TO_DAYS[range] || RANGE_TO_DAYS.Month, dateTo);

  const rows = await Attendance.find({
    ...scope,
    date: { $gte: dateFrom, $lte: dateTo },
    status: { $nin: ['holiday', 'leave'] }, // scheduled absences, not attendance behavior
  });

  const byDept = {};
  for (const row of rows) {
    const dept = row.dept || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { dept, present: 0, late: 0, absent: 0 };
    if (row.status === 'present') byDept[dept].present += 1;
    else if (row.status === 'late') byDept[dept].late += 1;
    else if (row.status === 'half-day') { byDept[dept].present += 0.5; byDept[dept].absent += 0.5; }
    else byDept[dept].absent += 1; // absent | early-exit
  }

  res.json({ from: dateFrom, to: dateTo, rows: Object.values(byDept) });
});

// ── Real QR check-in — server-issued/validated, replacing the old
// client-only Math.random() token that nothing server-side ever checked. ──

// The office display (HR-only view) polls this to render an always-current,
// scannable code — mints a fresh short-TTL single-use token each call.
router.get('/qr-token', requireRole('HR Manager'), (req, res) => {
  res.json(issueQrToken(req.auth.company));
});

// Scanned by the EMPLOYEE'S OWN authenticated device (the office display
// isn't logged in as them) — the token proves they were looking at a
// legitimately-displayed, currently-valid office code; their own session
// proves who they are. Deliberately doesn't also require a face photo (that
// would just reduce to the existing face check-in flow with an extra QR
// step) — this is a distinct, lower-friction channel, same trade-off this
// codebase already documents for face-login vs password+2FA.
router.post('/qr-checkin', async (req, res) => {
  const { token } = req.body || {};
  if (!token || !consumeQrToken(token, req.auth.company)) {
    return res.status(400).json({ error: { code: 'INVALID_QR_TOKEN', message: 'This QR code has expired or already been used — ask HR to refresh the display and scan again.' } });
  }
  if (!req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Your login is not linked to an employee profile.' } });
  }

  const row = await Attendance.findOne({ empId: req.auth.employeeId, date: todayISO(), ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Today's attendance row not found." } });

  const direction = !row.checkIn ? 'in' : (!row.checkOut ? 'out' : null);
  if (!direction) {
    return res.status(400).json({ error: { code: 'ALREADY_DONE', message: 'You have already checked in and out today.' } });
  }

  const settings = await getSettingsDoc(req.auth.company);
  const lat = req.body.lat != null ? Number(req.body.lat) : null;
  const lng = req.body.lng != null ? Number(req.body.lng) : null;
  const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;
  const timestamp = req.body.timestamp != null ? Number(req.body.timestamp) : null;

  let gpsResult = null;
  if (settings.gpsCheckInEnabled) {
    gpsResult = evaluateGeofence({ lat, lng, accuracy, timestamp }, settings);
    if (!gpsResult.ok) {
      return res.status(400).json({ error: { code: gpsResult.reason, message: gpsFailureMessage(gpsResult) } });
    }
  }

  const time = nowTimeIST();
  const hasGps = gpsResult?.inside;
  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);
  const address = hasGps ? await reverseGeocode(lat, lng) : null;
  const shift = resolveShiftForToday(String(row.empId), settings);

  const patch = direction === 'in'
    ? {
        checkIn: time,
        status: isLate(time, shift) ? 'late' : 'present',
        checkInLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkInAddress: address,
        checkInDetails: `QR Check-in${hasGps ? ' + GPS Verified' : ''}`,
        checkInIp: ip,
        checkInDevice: device,
      }
    : {
        checkOut: time,
        status: isHalfDay(row.checkIn, time, shift)
          ? 'half-day'
          : isEarlyExit(time, shift) ? 'early-exit' : row.status,
        checkOutLoc: hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkOutAddress: address,
        checkOutDetails: `QR Check-out${hasGps ? ' + GPS Verified' : ''}`,
        checkOutIp: ip,
        checkOutDevice: device,
      };

  const updated = await Attendance.findByIdAndUpdate(row._id, patch, { new: true });
  await logAudit(req, {
    action: direction === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
    before: row,
    after: updated,
  });

  if (direction === 'in' && updated.status === 'late') {
    await notifyAttendanceEvent({
      empId: updated.empId,
      title: 'Late Check-in',
      message: `${updated.name} checked in late today at ${updated.checkIn}.`,
      company: updated.company,
    });
  }

  res.json(updated);
});

router.get('/:id', async (req, res) => {
  const row = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

// Generic CRUD below is the HR-override surface (Attendance.jsx roster table,
// leave-approval side effects, employee add/remove cascades) — trusted callers
// only, gated by role. Self check-in/out has its own verified path further down.
router.post('/', requireRole('HR Manager'), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };
  const created = await Attendance.create(body);
  await logAudit(req, { action: 'Attendance record created', subject: created.name, after: created });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const patch = {};
  for (const field of ALLOWED_ATTENDANCE_FIELDS) {
    if (req.body?.[field] !== undefined) patch[field] = req.body[field];
  }
  const before = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  const updated = await Attendance.findOneAndUpdate({ _id: req.params.id, ...companyFilter(req) }, patch, { new: true });
  await logAudit(req, { action: 'Attendance updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const deleted = await Attendance.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  await logAudit(req, { action: 'Attendance record deleted', subject: deleted.name, before: deleted });
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

// ── Self check-in / check-out — the actually-guarded path ──────────────────
// Every fact used to decide the outcome (geofence distance, face match,
// shift/lateness, server clock) is re-derived here from data the server
// itself holds. For self-service, the uploaded photo is re-detected and
// re-matched against the enrolled descriptor server-side — a forged client
// can lie about a "faceVerified" flag, but not about what this server's own
// model sees in the photo it uploaded.
async function handlePunch(req, res, direction) {
  const row = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
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

  const settings = await getSettingsDoc(req.auth.company);
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
  const hasGpsCoords = lat != null && lng != null;
  const hasGps = gpsResult?.inside || hasGpsCoords;
  const details = faceResult
    ? (hasGpsCoords ? 'Face + GPS Verified' : 'Face Verified')
    : (hasGpsCoords ? 'GPS Verified' : 'Manual Punch');
  const verification = {
    face: faceResult ? { matched: true, confidence: Math.round(faceResult.confidence), distance: faceResult.distance } : null,
    gps: gpsResult || (hasGpsCoords ? { inside: true, distance: 0 } : null),
    verifiedAt: new Date().toISOString(),
  };

  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);
  const address = hasGpsCoords ? await reverseGeocode(lat, lng) : null;
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
        checkInLoc: hasGpsCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
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
        status: isHalfDay(row.checkIn, time, shift)
          ? 'half-day'
          : isEarlyExit(time, shift) ? 'early-exit' : row.status,
        checkOutLoc: hasGpsCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
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
  await logAudit(req, {
    action: direction === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
    before: row,
    after: updated,
  });

  if (direction === 'in' && updated.status === 'late') {
    await notifyAttendanceEvent({
      empId: updated.empId,
      title: 'Late Check-in',
      message: `${updated.name} checked in late today at ${updated.checkIn}.`,
      company: updated.company,
    });
  }

  res.json(updated);
}

router.post('/:id/check-in', upload, (req, res) => handlePunch(req, res, 'in'));
router.post('/:id/check-out', upload, (req, res) => handlePunch(req, res, 'out'));

export default router;
