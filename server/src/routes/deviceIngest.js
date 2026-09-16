import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import Attendance from '../models/Attendance.js';
import DeviceUserMapping from '../models/DeviceUserMapping.js';
import Settings from '../models/Settings.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay, nowTimeIST } from '../lib/shifts.js';
import { logAudit } from '../lib/auditLogger.js';
import { todayISO } from '../lib/dateUtils.js';
import { notifyAttendanceEvent } from '../lib/attendanceNotify.js';
import { safeCompare } from '../middleware/internalAuth.js';

const router = Router();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A terminal bridge polls steadily, so this is generous — but not unbounded.
// Without it, a leaked device key is an unlimited write channel into
// attendance for as long as nobody notices.
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Per company, not per IP: several terminals legitimately share one office
  // NAT address, and one busy site must not rate-limit another.
  keyGenerator: (req) => `device:${req.body?.company || 'unknown'}`,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Device punch rate limit exceeded.' } },
});

// Authenticates the calling DEVICE (not a user) against the company's
// biometricDeviceApiKey — a physical terminal has no user session/JWT to
// present, so this is a deliberately separate, simpler auth mechanism.
// Mounted as its own top-level route (not nested under /attendance) so it
// never passes through that router's router.use(requireAuth).
async function requireDeviceKey(req, res, next) {
  const { company } = req.body || {};
  const key = req.headers['x-device-key'];
  if (!company || !key) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing company or X-Device-Key header.' } });
  }
  const settings = await Settings.findById(company);
  // Constant-time comparison: `!==` on a secret leaks its prefix through
  // response timing to an attacker who can make enough requests.
  if (!settings?.biometricDeviceApiKey || !safeCompare(key, settings.biometricDeviceApiKey)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid device key.' } });
  }
  req.deviceCompany = company;
  next();
}

// The real, working HTTP surface a biometric-terminal bridge (e.g. a
// node-zklib process polling a ZKTeco/eSSL device) calls. The vendor TCP
// protocol itself is not implemented here (it needs physical hardware to
// develop against), but everything from this point applies the same
// server-computed lateness/half-day logic and audit trail as every other
// check-in path in this app.
router.post('/', deviceLimiter, requireDeviceKey, async (req, res) => {
  const { deviceId, deviceUserId, type, time } = req.body || {};
  const company = req.deviceCompany;

  if (!deviceId || !deviceUserId || !['in', 'out'].includes(type)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'deviceId, deviceUserId, and type ("in"|"out") are required.' } });
  }
  // `time` came straight off the wire into the attendance row, so a
  // misconfigured or hostile bridge could store "99:99" or an arbitrary
  // string as a punch time, which then fed the lateness and half-day
  // comparisons and the payroll LOP calculation downstream.
  if (time != null && !HHMM.test(String(time))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'time must be HH:MM in 24-hour form.' } });
  }

  const mapping = await DeviceUserMapping.findOne({ company, deviceId, deviceUserId });
  if (!mapping) {
    return res.status(404).json({ error: { code: 'DEVICE_USER_UNMAPPED', message: 'This device user is not linked to an employee yet — map it in Integrations first.' } });
  }

  const date = todayISO();
  const row = await Attendance.findOne({ empId: mapping.empId, date, company });
  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Today's attendance row not found for this employee." } });
  }

  // A terminal bridge retries on any network hiccup, and a person walking
  // through a turnstile twice produces two reads. Without this guard the
  // second one silently overwrote the first punch time.
  if (type === 'in' && row.checkIn) {
    return res.status(200).json({ ...row.toJSON(), duplicate: true, message: 'Check-in already recorded for today.' });
  }
  if (type === 'out' && !row.checkIn) {
    return res.status(400).json({ error: { code: 'NOT_CHECKED_IN', message: 'No check-in recorded for today.' } });
  }
  if (type === 'out' && row.checkOut) {
    return res.status(200).json({ ...row.toJSON(), duplicate: true, message: 'Check-out already recorded for today.' });
  }

  const settings = await Settings.findById(company);
  const punchTime = time || nowTimeIST();
  const shift = resolveShiftForToday(String(row.empId), settings);

  const patch = type === 'in'
    ? {
        checkIn: punchTime,
        status: isLate(punchTime, shift) ? 'late' : 'present',
        checkInDetails: `Biometric device (${deviceId})`,
        checkInDeviceId: deviceId,
        // The terminal performs its own 1:N biometric match; this app did not
        // see a face, so it records what was actually verified and by whom
        // rather than leaving the field blank and ambiguous.
        checkInVerification: {
          face: null,
          gps: null,
          liveness: { verified: false, reason: 'device-terminal' },
          source: 'biometric-device',
          deviceId,
          verifiedAt: new Date().toISOString(),
        },
      }
    : {
        checkOut: punchTime,
        status: isHalfDay(row.checkIn, punchTime, shift)
          ? 'half-day'
          : isEarlyExit(punchTime, shift) ? 'early-exit' : row.status,
        checkOutDetails: `Biometric device (${deviceId})`,
        checkOutDeviceId: deviceId,
        checkOutVerification: {
          face: null,
          gps: null,
          liveness: { verified: false, reason: 'device-terminal' },
          source: 'biometric-device',
          deviceId,
          verifiedAt: new Date().toISOString(),
        },
      };

  // Conditional update, so two reads arriving together produce one punch.
  const guard = type === 'in' ? { checkIn: null } : { checkOut: null, checkIn: { $ne: null } };
  const updated = await Attendance.findOneAndUpdate(
    { _id: row._id, company, ...guard },
    patch,
    { new: true },
  );
  if (!updated) {
    const current = await Attendance.findById(row._id);
    return res.status(200).json({ ...current.toJSON(), duplicate: true, message: 'That punch was already recorded.' });
  }

  await logAudit(req, {
    action: type === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
    details: patch.checkInDetails || patch.checkOutDetails,
    before: row,
    after: updated,
    actor: { name: `Device: ${deviceId}`, role: 'Device' },
    company,
  });

  if (type === 'in' && updated.status === 'late') {
    await notifyAttendanceEvent({
      empId: updated.empId,
      title: 'Late Check-in',
      message: `${updated.name} checked in late today at ${updated.checkIn} (biometric device).`,
      company,
    });
  }

  res.json(updated);
});

export default router;
