import { Router } from 'express';
import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { evaluateGeofence } from '../lib/geofence.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay, nowTimeIST } from '../lib/shifts.js';
import { parseDeviceInfo, clientIp } from '../lib/deviceInfo.js';
import { reverseGeocode } from '../lib/geocode.js';
import multer from 'multer';
import { extractDescriptor, matchDescriptor, faceFailureMessage } from '../lib/faceEngine.js';
import { issueChallenge, consumeChallenge, verifyLiveness, livenessFailureMessage, LIVENESS_TUNING } from '../lib/liveness.js';
import { recordFailedAttempt, recentFailureCount } from '../lib/verificationRecorder.js';
import { hasValidE2EHeader } from '../lib/e2eGuard.js';
import VerificationAttempt from '../models/VerificationAttempt.js';
import { savePhoto, randomFilename, wrapUpload } from '../lib/photoStorage.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import { todayISO, isoDateDaysAgo } from '../lib/dateUtils.js';
import { notifyAttendanceEvent } from '../lib/attendanceNotify.js';
import { issueQrToken, consumeQrToken } from '../lib/qrTokenStore.js';

const RANGE_TO_DAYS = { Week: 7, Month: 30, Quarter: 90 };

const SHARED_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Repeated rejections inside 15 minutes is what a spoofing attempt looks like.
// Deliberately a slow-down, not a lockout: a bad camera or poor light must not
// shut someone out of recording their own attendance — they can still ask HR.
const MAX_FAILED_ATTEMPTS_PER_WINDOW = 8;
// Accepts either the single `photo` field (the existing single-still flow) or
// a `frames` burst (the liveness flow). JPEG only: the client always captures
// via canvas.toBlob(..., 'image/jpeg'), and the server-side decoder is
// jpeg-js, so accepting PNG/WebP here only ever produced an opaque 500 when
// someone actually sent one.
const upload = wrapUpload(multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: LIVENESS_TUNING.MAX_FRAMES + 1,
    fields: 25,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'image/jpeg') {
      return cb(new Error('Check-in photo must be a JPEG image captured by the camera.'));
    }
    cb(null, true);
  },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'frames', maxCount: LIVENESS_TUNING.MAX_FRAMES },
]));

// Normalises the two upload shapes into one ordered frame list.
function collectFrames(req) {
  const frames = req.files?.frames || [];
  if (frames.length) return frames;
  return req.files?.photo || [];
}

// Client-settable roster fields for the HR-override PATCH — photo refs,
// company, and empId are always server-computed/scoped and must never come
// straight from the request body (that was the source of an earlier
// mass-assignment bug letting a caller point checkInPhotoRef/company at
// arbitrary values).
const ALLOWED_ATTENDANCE_FIELDS = ['name', 'dept', 'status', 'checkIn', 'checkOut'];

// Buddy-punching signal: the same physical device checking in for two
// different employees within a short window. A flag for HR review, not a
// hard block — a shared reception device is a legitimate case too.
async function findSharedDeviceFlag(deviceId, empId, rowId, company) {
  if (!deviceId) return null;
  const since = new Date(Date.now() - SHARED_DEVICE_WINDOW_MS);
  const other = await Attendance.findOne({
    // Scoped to the caller's own company. Without this, one tenant's device
    // ids were matched against every other tenant's attendance rows.
    company,
    _id: { $ne: rowId },
    empId: { $ne: empId },
    createdAt: { $gte: since },
    $or: [{ checkInDeviceId: deviceId }, { checkOutDeviceId: deviceId }],
  });
  return other ? 'shared-device' : null;
}

async function ensureTodaysAttendanceRow(empId, company) {
  if (!empId) return null;
  const date = todayISO();
  let row = await Attendance.findOne({ empId, date });
  if (!row) {
    const emp = await Employee.findById(empId);
    if (emp) {
      try {
        row = await Attendance.create({
          empId: emp._id,
          name: emp.name,
          dept: emp.dept,
          date,
          status: emp.status === 'on-leave' ? 'leave' : 'absent',
          company: emp.company || company || 'Smaatech',
        });
      } catch (err) {
        if (err.code === 11000) {
          row = await Attendance.findOne({ empId, date });
        }
      }
    }
  }
  return row;
}

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  if (req.auth?.employeeId) {
    await ensureTodaysAttendanceRow(req.auth.employeeId, req.auth.company);
  }
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const scope = { ...companyFilter(req), ...(isManager ? {} : { empId: req.auth.employeeId }) };
  const { page, limit, date, from, to } = req.query;

  const filter = { ...scope };
  if (date) {
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }

  // Legacy callers get the array shape, but capped at a safe max limit (100 rows)
  // to prevent out-of-memory (OOM) process crashes on large datasets.
  //
  // The date filter is applied here too. It used to be built only on the paged
  // branch, so `GET /attendance?date=2026-09-12` — with no page or limit —
  // silently ignored the date and returned the 100 most recent rows instead.
  // A caller asking for one day got a different day's data and no indication
  // that anything had been dropped.
  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const rows = await Attendance.find(filter).sort({ date: -1, createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(rows);
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

  // Aggregated in the DATABASE, not in Node.
  //
  // This previously did Attendance.find(...) over the whole range and summed
  // in a JavaScript loop — so a 500-employee company asking for one month
  // hydrated 15,000 full Mongoose documents into the heap per request, on the
  // endpoint that backs the dashboard chart every user loads. Measured with
  // scripts/loadprobe.js on exactly that dataset: p50 463ms at concurrency 1,
  // and 4,642ms at concurrency 10 — the event loop was pinned building
  // documents. The group runs on the (company, date, status) index and returns
  // one row per department instead.
  const byDept = await Attendance.aggregate([
    {
      $match: {
        ...scope,
        date: { $gte: dateFrom, $lte: dateTo },
        status: { $nin: ['holiday', 'leave'] }, // scheduled absences, not attendance behavior
      },
    },
    {
      $group: {
        // Matches the old `row.dept || 'Unassigned'`, which treated a missing
        // dept, null and an empty string alike.
        _id: { $ifNull: [{ $cond: [{ $eq: ['$dept', ''] }, null, '$dept'] }, 'Unassigned'] },
        present: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'present'] }, then: 1 },
                { case: { $eq: ['$status', 'half-day'] }, then: 0.5 },
              ],
              default: 0,
            },
          },
        },
        late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
        absent: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'half-day'] }, then: 0.5 },
                { case: { $in: ['$status', ['present', 'late']] }, then: 0 },
              ],
              default: 1, // absent | early-exit
            },
          },
        },
      },
    },
    { $project: { _id: 0, dept: '$_id', present: 1, late: 1, absent: 1 } },
    { $sort: { dept: 1 } },
  ]);

  res.json({ from: dateFrom, to: dateTo, rows: byDept });
});

// ── Real QR check-in — server-issued/validated, replacing the old
// client-only Math.random() token that nothing server-side ever checked. ──

// The office display (HR-only view) polls this to render an always-current,
// scannable code — mints a fresh short-TTL single-use token each call.
router.get('/qr-token', requireRole('HR Manager'), async (req, res) => {
  res.json(await issueQrToken(req.auth.company));
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
  if (!token || !(await consumeQrToken(token, req.auth.company))) {
    return res.status(400).json({ error: { code: 'INVALID_QR_TOKEN', message: 'This QR code has expired or already been used — ask HR to refresh the display and scan again.' } });
  }
  if (!req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Your login is not linked to an employee profile.' } });
  }

  let row = await Attendance.findOne({ empId: req.auth.employeeId, date: todayISO(), ...companyFilter(req) });
  if (!row) {
    row = await ensureTodaysAttendanceRow(req.auth.employeeId, req.auth.company);
  }
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
  const hasGpsCoords = lat != null && lng != null;
  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);
  const address = hasGpsCoords ? await reverseGeocode(lat, lng) : null;
  const shift = resolveShiftForToday(String(row.empId), settings);

  const patch = direction === 'in'
    ? {
        checkIn: time,
        status: isLate(time, shift) ? 'late' : 'present',
        checkInLoc: hasGpsCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkInAddress: address,
        checkInDetails: `QR Check-in${hasGpsCoords ? (gpsResult ? ' + GPS Verified' : ' + GPS Recorded') : ''}`,
        checkInIp: ip,
        checkInDevice: device,
      }
    : {
        checkOut: time,
        status: isHalfDay(row.checkIn, time, shift)
          ? 'half-day'
          : isEarlyExit(time, shift) ? 'early-exit' : row.status,
        checkOutLoc: hasGpsCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkOutAddress: address,
        checkOutDetails: `QR Check-out${hasGpsCoords ? (gpsResult ? ' + GPS Verified' : ' + GPS Recorded') : ''}`,
        checkOutIp: ip,
        checkOutDevice: device,
      };

  // Same conditional-update guard as handlePunch: the geocode round-trip
  // between reading the row and writing it is wide enough for a second scan
  // to slip through.
  const guard = direction === 'in' ? { checkIn: null } : { checkOut: null, checkIn: { $ne: null } };
  const updated = await Attendance.findOneAndUpdate(
    { _id: row._id, ...companyFilter(req), ...guard },
    patch,
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({
      error: { code: 'ALREADY_DONE', message: 'That punch was already recorded.' },
    });
  }

  await logAudit(req, {
    action: direction === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
    details: patch.checkInDetails || patch.checkOutDetails,
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

// ── HR/Admin verification dossier ────────────────────────────────────────
// Everything needed to adjudicate a single employee-day in one response:
// who, when, the verification result, the structured location, the device,
// and EVERY rejected attempt against that day with its retained photo.
//
// Previously this information was scattered: the punch fields sat on the
// attendance row, the failures went only to AuditLog (HR-Director-only, so
// the HR Managers who run attendance could not see them), and the rejected
// captures were discarded entirely.
router.get('/:id/verification', requireRole('HR Manager'), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  }
  const row = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const employee = await Employee.findOne({ _id: row.empId, ...companyFilter(req) });

  const attempts = await VerificationAttempt.find({
    company: req.auth.company,
    empId: row.empId,
    date: row.date,
  }).sort({ createdAt: -1 }).limit(50);

  const side = (dir) => ({
    time: dir === 'in' ? row.checkIn : row.checkOut,
    details: dir === 'in' ? row.checkInDetails : row.checkOutDetails,
    verification: dir === 'in' ? row.checkInVerification : row.checkOutVerification,
    faceConfidence: dir === 'in' ? row.checkInFaceConfidence : row.checkOutFaceConfidence,
    // The photo is never handed out as a storage path — this is the
    // authenticated route that streams it after its own access check.
    photoUrl: (dir === 'in' ? row.checkInPhotoRef : row.checkOutPhotoRef)
      ? `/api/v1/files/attendance/${row._id}/${dir === 'in' ? 'checkIn' : 'checkOut'}`
      : null,
    location: dir === 'in' ? row.checkInLocation : row.checkOutLocation,
    coordinates: dir === 'in' ? row.checkInLoc : row.checkOutLoc,
    address: dir === 'in' ? row.checkInAddress : row.checkOutAddress,
    accuracy: dir === 'in' ? row.checkInAccuracy : row.checkOutAccuracy,
    device: dir === 'in' ? row.checkInDevice : row.checkOutDevice,
    deviceId: dir === 'in' ? row.checkInDeviceId : row.checkOutDeviceId,
    ip: dir === 'in' ? row.checkInIp : row.checkOutIp,
  });

  res.json({
    attendanceId: String(row._id),
    date: row.date,
    status: row.status,
    employee: {
      id: String(row.empId),
      name: employee?.name || row.name,
      employeeCode: employee?.employeeCode || null,
      dept: employee?.dept || row.dept,
      role: employee?.role || null,
      photo: employee?.photo || null,
    },
    checkIn: side('in'),
    checkOut: side('out'),
    anomalyFlags: row.anomalyFlags || [],
    failedVerificationCount: row.failedVerificationCount || 0,
    failedAttempts: attempts.map((a) => ({
      ...a.toJSON(),
      photoUrl: a.photoRef ? `/api/v1/files/verification-attempt/${a._id}` : null,
    })),
  });
});

// Company-wide rejected-attempt feed, for the HR review screen.
router.get('/verification/attempts', requireRole('HR Manager'), async (req, res) => {
  const filter = { company: req.auth.company };
  if (req.query.date) filter.date = String(req.query.date);
  if (req.query.empId && mongoose.Types.ObjectId.isValid(String(req.query.empId))) {
    filter.empId = req.query.empId;
  }
  if (req.query.stage) filter.stage = String(req.query.stage);

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = await VerificationAttempt.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json(rows.map((a) => ({
    ...a.toJSON(),
    photoUrl: a.photoRef ? `/api/v1/files/verification-attempt/${a._id}` : null,
  })));
});

router.get('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  }
  const row = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  // An employee may read their own row; only HR sees anyone else's, which
  // carries device ids, IP addresses, GPS coordinates and face-match scores.
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwn = req.auth.employeeId && req.auth.employeeId === String(row.empId);
  if (!isManager && !isOwn) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });
  }
  res.json(row);
});

// Generic CRUD below is the HR-override surface (Attendance.jsx roster table,
// leave-approval side effects, employee add/remove cascades) — trusted callers
// only, gated by role. Self check-in/out has its own verified path further down.
router.post('/', requireRole('HR Manager'), async (req, res) => {
  // Allow-list, not a spread of req.body: the old version let a caller set
  // checkInPhotoRef, checkInVerification and the face-confidence fields
  // directly, i.e. fabricate a "Face + GPS Verified" attendance record with
  // no face and no GPS anywhere in the request.
  const body = { company: req.auth.company };
  for (const field of [...ALLOWED_ATTENDANCE_FIELDS, 'empId', 'date']) {
    if (req.body?.[field] !== undefined) body[field] = req.body[field];
  }
  if (!body.empId || !mongoose.Types.ObjectId.isValid(String(body.empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid empId is required.' } });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'date must be YYYY-MM-DD.' } });
  }
  if (!(await Employee.exists({ _id: body.empId, company: req.auth.company }))) {
    return res.status(404).json({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found in this company.' } });
  }
  body.checkInDetails = 'HR Manual Entry';

  try {
    const created = await Attendance.create(body);
    await logAudit(req, { action: 'Attendance record created', subject: created.name, after: created });
    res.status(201).json(created);
  } catch (err) {
    // The unique (empId, date) index — previously surfaced as a raw 500.
    if (err.code === 11000) {
      return res.status(409).json({
        error: { code: 'ATTENDANCE_EXISTS', message: 'An attendance row already exists for that employee and date.' },
      });
    }
    throw err;
  }
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const patch = {};
  for (const field of ALLOWED_ATTENDANCE_FIELDS) {
    if (req.body?.[field] !== undefined) patch[field] = req.body[field];
  }
  const before = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);

  if (patch.checkIn && !before.checkIn) {
    if (!patch.checkInDetails) patch.checkInDetails = 'HR Manual Override';
    if (!patch.checkInDevice) patch.checkInDevice = device;
    if (!patch.checkInIp) patch.checkInIp = ip;
    if (!patch.checkInDeviceId) patch.checkInDeviceId = 'HR-Console';
  }
  if (patch.checkOut && !before.checkOut) {
    if (!patch.checkOutDetails) patch.checkOutDetails = 'HR Manual Override';
    if (!patch.checkOutDevice) patch.checkOutDevice = device;
    if (!patch.checkOutIp) patch.checkOutIp = ip;
    if (!patch.checkOutDeviceId) patch.checkOutDeviceId = 'HR-Console';
  }

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

// -- Self check-in / check-out: the actually-guarded path ------------------
// Every fact used to decide the outcome (geofence distance, face match,
// liveness, shift/lateness, server clock) is re-derived here from data the
// server itself holds. The uploaded photo is re-detected and re-matched
// against the enrolled descriptor server-side: a forged client can lie about
// a "faceVerified" flag, but not about what this server's own model sees in
// the photo it uploaded.
async function handlePunch(req, res, direction) {
  const row = await Attendance.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attendance row not found.' } });

  if (direction === 'in' && row.checkIn) {
    return res.status(409).json({ error: { code: 'ALREADY_CHECKED_IN', message: 'You have already checked in today.' } });
  }
  if (direction === 'out' && !row.checkIn) {
    return res.status(400).json({ error: { code: 'NOT_CHECKED_IN', message: 'You must check in before checking out.' } });
  }
  if (direction === 'out' && row.checkOut) {
    return res.status(409).json({ error: { code: 'ALREADY_CHECKED_OUT', message: 'You have already checked out today.' } });
  }

  const isAdminRole = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isOwnRow = Boolean(req.auth.employeeId) && req.auth.employeeId === String(row.empId);
  if (!isAdminRole && !isOwnRow) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only check yourself in or out.' } });
  }

  // An HR override on SOMEONE ELSE'S row is a trusted manual action and keeps
  // working unconditionally (it is fully audited as such). But an HR Manager
  // punching THEIR OWN attendance is self-service like anyone else's, and
  // previously skipped face and geofence verification entirely, making the
  // people who administer attendance the only ones who could mark themselves
  // present from anywhere with no biometric check. Same rules for everyone on
  // their own row.
  const isSelfService = isOwnRow;
  const isHrOverride = isAdminRole && !isOwnRow;

  const settings = await getSettingsDoc(req.auth.company);
  const lat = req.body.lat != null ? Number(req.body.lat) : null;
  const lng = req.body.lng != null ? Number(req.body.lng) : null;
  const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;
  const timestamp = req.body.timestamp != null ? Number(req.body.timestamp) : null;
  const deviceId = req.body.deviceId ? String(req.body.deviceId).slice(0, 128) : null;

  let gpsResult = null;
  if (settings.gpsCheckInEnabled && isSelfService) {
    gpsResult = evaluateGeofence({ lat, lng, accuracy, timestamp }, settings);
    if (!gpsResult.ok) {
      const rejectGeo = (lat != null && lng != null) ? await reverseGeocode(lat, lng, { accuracy }) : null;
      await recordFailedAttempt(req, {
        row, direction, stage: 'geofence', reasonCode: gpsResult.reason,
        reasonMessage: gpsFailureMessage(gpsResult),
        geo: rejectGeo, gpsResult, deviceId,
      });
      return res.status(400).json({ error: { code: gpsResult.reason, message: gpsFailureMessage(gpsResult) } });
    }
  }

  // Resolved up-front so a REJECTED attempt records where it happened too —
  // "wrong face, and it was 40km from the office" is the useful fact, and it
  // was previously lost because geocoding only ran on the success path.
  // Started now but NOT awaited: it is a network call to Nominatim (up to 5s),
  // and awaiting it here made every punch wait for it before face matching
  // even began. It runs alongside the face check instead.
  const geoPromise = (lat != null && lng != null)
    ? reverseGeocode(lat, lng, { accuracy }).catch(() => null)
    : Promise.resolve(null);

  let faceResult = null;
  let livenessResult = null;
  let photoBuffer = null;
  if (isSelfService) {
    const frameFiles = collectFrames(req);
    if (!frameFiles.length) {
      await recordFailedAttempt(req, {
        row, direction, stage: 'photo', reasonCode: 'NO_PHOTO',
        reasonMessage: faceFailureMessage('NO_PHOTO'), geo: await geoPromise, gpsResult, deviceId,
      });
      return res.status(400).json({ error: { code: 'NO_PHOTO', message: faceFailureMessage('NO_PHOTO') } });
    }
    photoBuffer = frameFiles[0].buffer;

    // Repeated rejections in a short window are what a spoofing or
    // buddy-punching attempt looks like. Slowed down rather than locked out,
    // so nobody is shut out of their own attendance by a bad camera.
    // Independent lookups (the enrolled face is used further down): fetched
    // together rather than one after the other.
    const [recentFailures, enrolled] = await Promise.all([
      recentFailureCount({ company: req.auth.company, userId: req.auth.sub }),
      FaceDescriptor.findOne({ userId: req.auth.sub }),
    ]);
    if (recentFailures >= MAX_FAILED_ATTEMPTS_PER_WINDOW) {
      await recordFailedAttempt(req, {
        row, direction, stage: 'face', reasonCode: 'TOO_MANY_FAILED_ATTEMPTS',
        reasonMessage: 'Too many failed verification attempts.',
        photoBuffer, geo: await geoPromise, gpsResult, deviceId,
      });
      return res.status(429).json({
        error: {
          code: 'TOO_MANY_FAILED_ATTEMPTS',
          message: `Too many failed verification attempts. Wait a few minutes, or ask HR to record this punch for you.`,
        },
      });
    }

    // THE identity check: the capture is compared against the enrolled face of
    // THE SIGNED-IN ACCOUNT (req.auth.sub), never against the roster at large.
    // So valid credentials plus somebody else's face fails here, which is the
    // buddy-punching case this whole path exists to stop. (`enrolled` is
    // fetched above, alongside the failure count.)

    // Isolated browser-E2E mode: a headless browser has no camera and no real
    // face. The IDENTITY RULE IS STILL ENFORCED — the request must name which
    // account's face it is presenting, and that is matched against the
    // signed-in account exactly as a real capture would be. A test presenting
    // another employee's face id is rejected the same way. Unreachable in
    // production (see lib/e2eGuard.js).
    const e2eMode = hasValidE2EHeader(req);
    if (e2eMode && enrolled) {
      const presentedUserId = String(req.body.e2eFaceUserId || req.auth.sub);
      if (presentedUserId !== String(req.auth.sub)) {
        await recordFailedAttempt(req, {
          row, direction, stage: 'face', reasonCode: 'FACE_NOT_MATCHED',
          reasonMessage: faceFailureMessage('FACE_NOT_MATCHED'),
          photoBuffer, geo: await geoPromise, gpsResult, deviceId, faceDistance: 1.0, faceConfidence: 0,
        });
        return res.status(400).json({ error: { code: 'FACE_NOT_MATCHED', message: faceFailureMessage('FACE_NOT_MATCHED') } });
      }
      faceResult = { matched: true, confidence: 95, distance: 0.05 };
    }
    if (!enrolled) {
      await recordFailedAttempt(req, {
        row, direction, stage: 'enrollment', reasonCode: 'NOT_ENROLLED',
        reasonMessage: faceFailureMessage('NOT_ENROLLED'), photoBuffer, geo: await geoPromise, gpsResult, deviceId,
      });
      return res.status(400).json({ error: { code: 'NOT_ENROLLED', message: faceFailureMessage('NOT_ENROLLED') } });
    }

    // Liveness is opt-in per company (Settings.livenessRequired) because it
    // needs the multi-frame capture UI. When it is on, a single still is
    // rejected outright, which is the entire point of the check.
    if (settings.livenessRequired && !faceResult) {
      const challengeId = req.body.challengeId;
      const challenge = challengeId ? await consumeChallenge(challengeId, req.auth.sub) : null;
      if (!challenge) {
        return res.status(400).json({ error: { code: 'CHALLENGE_EXPIRED', message: livenessFailureMessage('CHALLENGE_EXPIRED') } });
      }
      const verdict = await verifyLiveness({
        frameBuffers: frameFiles.map((f) => f.buffer),
        action: challenge.action,
        enrolledDescriptor: enrolled.descriptor,
      });
      if (!verdict.ok) {
        await recordFailedAttempt(req, {
          row, direction, stage: 'liveness', reasonCode: verdict.reason,
          reasonMessage: livenessFailureMessage(verdict.reason),
          photoBuffer, geo: await geoPromise, gpsResult, deviceId,
        });
        await logAudit(req, {
          action: 'Failed liveness check',
          subject: row.name || String(req.auth.sub),
          details: `${verdict.reason} during ${direction === 'in' ? 'check-in' : 'check-out'}`,
        });
        return res.status(400).json({
          error: { code: verdict.reason, message: livenessFailureMessage(verdict.reason) },
        });
      }
      livenessResult = verdict.detail;
      // verifyLiveness already matched EVERY frame against the enrolled
      // descriptor, so a further single-frame match would be redundant.
      faceResult = { matched: true, confidence: verdict.detail.minMatchConfidence, distance: null };
    } else if (!faceResult) {
      const extraction = await extractDescriptor(photoBuffer);
      if (extraction.error) {
        await recordFailedAttempt(req, {
          row, direction, stage: 'face', reasonCode: extraction.error,
          reasonMessage: faceFailureMessage(extraction.error),
          photoBuffer, geo: await geoPromise, gpsResult, deviceId,
        });
        return res.status(400).json({ error: { code: extraction.error, message: faceFailureMessage(extraction.error) } });
      }
      const match = matchDescriptor(extraction.descriptor, enrolled.descriptor);
      if (!match.matched) {
        // The capture is retained as evidence: this is the record that shows
        // a valid login was used with a face that is not the account holder's.
        await recordFailedAttempt(req, {
          row, direction, stage: 'face', reasonCode: 'FACE_NOT_MATCHED',
          reasonMessage: faceFailureMessage('FACE_NOT_MATCHED'),
          photoBuffer, geo: await geoPromise, gpsResult, deviceId,
          faceDistance: match.distance,
          faceConfidence: Math.round(match.confidence),
        });
        await logAudit(req, {
          action: 'Failed face verification attempt',
          subject: row.name || String(req.auth.sub),
          details: `Face mismatch during ${direction === 'in' ? 'check-in' : 'check-out'} (distance: ${match.distance.toFixed(2)})`,
        });
        return res.status(400).json({ error: { code: 'FACE_NOT_MATCHED', message: faceFailureMessage('FACE_NOT_MATCHED') } });
      }
      faceResult = match;
    }
  }

  const geo = await geoPromise;
  const time = nowTimeIST();
  const hasGpsCoords = lat != null && lng != null;
  // "GPS Verified" only when the geofence was actually evaluated and passed.
  // With geofencing off, coordinates are just recorded; calling that
  // "verified" told HR a location check happened that never did.
  const gpsChecked = Boolean(gpsResult);
  const details = faceResult
    ? (livenessResult
      ? (hasGpsCoords ? (gpsChecked ? 'Face + Liveness + GPS Verified' : 'Face + Liveness Verified + GPS Recorded') : 'Face + Liveness Verified')
      : (hasGpsCoords ? (gpsChecked ? 'Face + GPS Verified' : 'Face Verified + GPS Recorded') : 'Face Verified'))
    : (isHrOverride ? 'HR Manual Punch' : (hasGpsCoords ? (gpsChecked ? 'GPS Verified' : 'GPS Recorded') : 'Manual Punch'));

  const verification = {
    face: faceResult ? { matched: true, confidence: Math.round(faceResult.confidence), distance: faceResult.distance } : null,
    // Never record a liveness claim the server did not actually make. A punch
    // taken without the liveness flow stores verified:false and says why, so
    // an auditor can tell a liveness-checked punch from an unchecked one.
    liveness: livenessResult
      ? { verified: true, ...livenessResult }
      : { verified: false, reason: isHrOverride ? 'hr-override' : (settings.livenessRequired ? 'not-performed' : 'not-required-by-policy') },
    // Same rule as liveness: never record a geofence verdict the server did
    // not reach. This used to store { inside: true, distance: 0 } whenever
    // geofencing was off, i.e. evidence of a check that never ran.
    gps: gpsResult
      || (hasGpsCoords
        ? { evaluated: false, reason: isHrOverride ? 'hr-override' : 'geofence-disabled' }
        : null),
    verifiedAt: new Date().toISOString(),
  };

  const device = parseDeviceInfo(req.headers['user-agent']);
  const ip = clientIp(req);
  const effectiveDeviceId = deviceId || (isHrOverride ? 'HR-Console' : null);
  const address = geo?.display || null;
  const structuredLocation = geo ? {
    placeName: geo.placeName, fullAddress: geo.fullAddress, pincode: geo.pincode,
    area: geo.area, city: geo.city, district: geo.district, state: geo.state, country: geo.country,
    lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy, source: geo.source, resolvedAt: geo.resolvedAt,
  } : undefined;
  // Independent of each other, so done concurrently.
  const [sharedDeviceFlag, photoRef] = await Promise.all([
    isSelfService
      ? findSharedDeviceFlag(effectiveDeviceId, row.empId, row._id, req.auth.company)
      : null,
    photoBuffer
      ? savePhoto(`attendance/${row.empId}`, randomFilename('.jpg'), photoBuffer)
      : null,
  ]);
  const anomalyFlags = sharedDeviceFlag
    ? [...new Set([...(row.anomalyFlags || []), sharedDeviceFlag])]
    : row.anomalyFlags;

  const shift = resolveShiftForToday(String(row.empId), settings);
  const patch = direction === 'in'
    ? {
        checkIn: time,
        status: isLate(time, shift) ? 'late' : 'present',
        checkInLoc: hasGpsCoords ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : null,
        checkInAddress: address,
        ...(structuredLocation ? { checkInLocation: structuredLocation } : {}),
        checkInDetails: details,
        checkInVerification: verification,
        checkInAccuracy: accuracy,
        checkInDeviceId: effectiveDeviceId,
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
        ...(structuredLocation ? { checkOutLocation: structuredLocation } : {}),
        checkOutDetails: details,
        checkOutVerification: verification,
        checkOutAccuracy: accuracy,
        checkOutDeviceId: effectiveDeviceId,
        checkOutDevice: device,
        checkOutIp: ip,
        checkOutPhotoRef: photoRef,
        checkOutFaceConfidence: faceResult ? Math.round(faceResult.confidence) : null,
        anomalyFlags,
      };

  // CONDITIONAL update, not a blind write. The guard at the top of this
  // handler read the row, then face/liveness/geocoding ran for hundreds of
  // milliseconds before the write. A second request arriving in that window
  // passed the same guard, and both wrote: two audited check-ins for one
  // employee-day, the later photo silently replacing the earlier. Re-asserting
  // "the field is still empty" inside the query makes the database pick the
  // winner instead of last-write-wins.
  const guard = direction === 'in' ? { checkIn: null } : { checkOut: null, checkIn: { $ne: null } };
  const updated = await Attendance.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req), ...guard },
    patch,
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({
      error: {
        code: direction === 'in' ? 'ALREADY_CHECKED_IN' : 'ALREADY_CHECKED_OUT',
        message: direction === 'in'
          ? 'You have already checked in today.'
          : 'You have already checked out today.',
      },
    });
  }

  await logAudit(req, {
    action: direction === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
    details: isHrOverride ? `${details} (HR override for another employee)` : details,
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

// Issues the single-use liveness challenge the client must satisfy. Scoped to
// the caller's own account, so nobody can request a challenge on another
// person's behalf.
router.get('/liveness/challenge', async (req, res) => {
  res.json(await issueChallenge(req.auth.sub));
});

router.post('/:id/check-in', upload, (req, res) => handlePunch(req, res, 'in'));
router.post('/:id/check-out', upload, (req, res) => handlePunch(req, res, 'out'));

export default router;
