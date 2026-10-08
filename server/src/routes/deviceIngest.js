import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import Device from '../models/Device.js';
import DeviceUserMapping from '../models/DeviceUserMapping.js';
import Settings from '../models/Settings.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay, nowTimeIST } from '../lib/shifts.js';
import { workedMinutesBetween } from '../lib/workingHours.js';
import { validateCoordinates, describePunchLocation } from '../lib/geofence.js';
import { reverseGeocode } from '../lib/geocode.js';
import { clientIp } from '../lib/deviceInfo.js';
import { claimShared, updateShared, removeShared } from '../lib/sharedStore.js';
import { logAudit } from '../lib/auditLogger.js';
import { todayISO } from '../lib/dateUtils.js';
import { notifyAttendanceEvent } from '../lib/attendanceNotify.js';
import { safeCompare } from '../middleware/internalAuth.js';
import { hashDeviceKey } from './devices.js';
import logger from '../lib/logger.js';

const router = Router();

// The machine does its own matching; the HRMS records which factors it used.
// Both are required for this workflow.
const REQUIRED_VERIFICATION = 'face_and_fingerprint';
// Only a live, online punch is accepted: the device's own clock must agree
// with the server's to within this window. There is no offline upload.
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
// An event id is remembered for longer than a request can stay valid, so the
// same request sent twice is recognised for as long as it could be accepted.
const EVENT_MEMORY_MS = 3 * TIMESTAMP_TOLERANCE_MS;
const EVENT_ID = /^[A-Za-z0-9._:-]{8,64}$/;

// A terminal sends one request per punch, so this is generous — but not
// unbounded. Without it, a leaked device key is an unlimited write channel
// into attendance for as long as nobody notices.
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Per device, not per IP: several terminals legitimately share one office
  // NAT address, and one busy machine must not rate-limit another.
  keyGenerator: (req) => `device:${String(req.headers['x-device-id'] || 'unknown').slice(0, 64)}`,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Device punch rate limit exceeded.' } },
});

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// Authenticates the calling DEVICE (not a user): a physical terminal has no
// user session to present, so it carries its own id and its own key. Mounted
// as its own top-level route (not nested under /attendance) so it never
// passes through that router's router.use(requireAuth).
async function requireDevice(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const key = req.headers['x-device-key'];
  if (typeof deviceId !== 'string' || typeof key !== 'string' || !deviceId || !key) {
    return fail(res, 401, 'UNAUTHORIZED', 'X-Device-Id and X-Device-Key headers are required.');
  }
  const device = await Device.findOne({ deviceId });
  // One answer for "no such device" and "wrong key", in constant time, so a
  // caller cannot learn which device ids exist.
  const expected = device?.keyHash || hashDeviceKey('no-such-device');
  const matches = safeCompare(hashDeviceKey(key), expected);
  if (!device || !device.keyHash || !matches) {
    return fail(res, 401, 'UNAUTHORIZED', 'Unknown device or invalid device key.');
  }
  if (!device.active) return fail(res, 403, 'DEVICE_DISABLED', 'This device has been disabled in the HRMS.');
  req.device = device;
  next();
}

// Today's row for the employee, created if the daily job has not made it yet
// (the same shape the rest of the app creates).
async function todaysRowFor(empId, company) {
  const date = todayISO();
  let row = await Attendance.findOne({ empId, date, company });
  if (row) return row;
  const emp = await Employee.findOne({ _id: empId, company });
  if (!emp) return null;
  try {
    row = await Attendance.create({
      empId: emp._id, name: emp.name, dept: emp.dept, date,
      status: emp.status === 'on-leave' ? 'leave' : 'absent', company,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    row = await Attendance.findOne({ empId, date, company });
  }
  return row;
}

// Where the punch happened. A mounted machine reports no GPS, so its
// registered site is the location. If a request does carry coordinates they
// go through the same address lookup as a mobile or web punch.
async function locationOf(device, body) {
  const sent = body?.location;
  if (sent !== undefined && sent !== null) {
    const lat = Number(sent.lat);
    const lng = Number(sent.lng);
    const accuracy = sent.accuracy == null ? null : Number(sent.accuracy);
    if (typeof sent !== 'object' || sent.lat == null || sent.lng == null || !validateCoordinates(lat, lng).ok
      || (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0))) {
      return { error: true };
    }
    const geo = await reverseGeocode(lat, lng, { accuracy }).catch(() => null);
    const { address } = describePunchLocation(geo, { accuracy });
    return {
      loc: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      // An unresolved lookup still leaves a readable place: the site the
      // device is registered at.
      address: address || device.siteAddress,
      accuracy,
      structured: {
        placeName: geo?.placeName ?? null, fullAddress: geo?.fullAddress ?? null, pincode: geo?.pincode ?? null,
        area: geo?.area ?? null, city: geo?.city ?? null, district: geo?.district ?? null,
        state: geo?.state ?? null, country: geo?.country ?? null,
        lat, lng, accuracy, source: geo?.source ?? 'unresolved', resolvedAt: geo?.resolvedAt ?? new Date().toISOString(),
      },
    };
  }
  const hasSiteCoords = device.siteLat != null && device.siteLng != null;
  return {
    loc: hasSiteCoords ? `${device.siteLat.toFixed(5)}, ${device.siteLng.toFixed(5)}` : null,
    address: device.siteAddress,
    accuracy: null,
    structured: {
      placeName: device.name, fullAddress: device.siteAddress, pincode: null,
      area: null, city: null, district: null, state: null, country: null,
      lat: hasSiteCoords ? device.siteLat : null, lng: hasSiteCoords ? device.siteLng : null,
      accuracy: null, source: 'device-site', resolvedAt: new Date().toISOString(),
    },
  };
}

const accepted = (row, type, duplicate) => ({
  success: true,
  attendanceId: String(row._id),
  employeeId: String(row.empId),
  type,
  date: row.date,
  time: type === 'in' ? row.checkIn : row.checkOut,
  status: row.status,
  duplicate,
});

/**
 * POST /api/v1/device-punch — one live attendance event from a registered
 * face + fingerprint machine. It writes the same Attendance row, through the
 * same shift, lateness, half-day and early-exit rules, as every other
 * check-in path; mobile and web punches do not pass through here.
 */
router.post('/', deviceLimiter, requireDevice, async (req, res) => {
  const { device } = req;
  const { eventId, deviceUserId, type, verification, timestamp } = req.body || {};
  const company = device.company;

  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    return fail(res, 400, 'BAD_REQUEST', 'eventId is required: 8 to 64 characters (letters, digits, . _ : -), unique per punch.');
  }
  if (deviceUserId == null || String(deviceUserId).trim() === '' || String(deviceUserId).length > 64) {
    return fail(res, 400, 'BAD_REQUEST', 'deviceUserId is required.');
  }
  if (!['in', 'out'].includes(type)) {
    return fail(res, 400, 'INVALID_EVENT', 'type must be "in" (check-in) or "out" (check-out).');
  }
  if (verification !== REQUIRED_VERIFICATION) {
    return fail(res, 400, 'VERIFICATION_REQUIRED', `verification must be "${REQUIRED_VERIFICATION}": both factors are required.`);
  }
  // ISO 8601 with an explicit offset or Z, so the instant is unambiguous.
  const at = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(at)) {
    return fail(res, 400, 'INVALID_TIMESTAMP', 'timestamp must be ISO 8601 with an offset, e.g. 2026-10-08T09:02:11+05:30.');
  }
  if (Math.abs(Date.now() - at) > TIMESTAMP_TOLERANCE_MS) {
    return fail(res, 400, 'INVALID_TIMESTAMP', 'timestamp is not current. Only live punches are accepted: check the device clock and send the punch as it happens.');
  }

  // The same event sent twice (a retry, or a captured request replayed) is
  // answered with what the first one produced and changes nothing.
  const eventKey = `device-event:${device.deviceId}:${eventId}`;
  const claim = await claimShared(eventKey, { state: 'processing' }, EVENT_MEMORY_MS);
  if (!claim.claimed) {
    if (claim.value?.response) return res.status(200).json({ ...claim.value.response, duplicate: true });
    return fail(res, 409, 'EVENT_IN_PROGRESS', 'This event is already being processed.');
  }
  // A refused event is forgotten, so the device can send it again once the
  // cause (an unmapped user, say) has been put right.
  const refuse = async (status, code, message) => {
    await removeShared(eventKey).catch(() => {});
    return fail(res, status, code, message);
  };

  try {
    const mapping = await DeviceUserMapping.findOne({ company, deviceId: device.deviceId, deviceUserId: String(deviceUserId) });
    if (!mapping) {
      return await refuse(404, 'DEVICE_USER_UNMAPPED', 'This device user is not linked to an employee in the HRMS yet.');
    }
    const place = await locationOf(device, req.body);
    if (place.error) {
      return await refuse(400, 'INVALID_LOCATION', 'location must have valid lat and lng (and a non-negative accuracy), or be left out.');
    }
    const row = await todaysRowFor(mapping.empId, company);
    if (!row) {
      return await refuse(404, 'EMPLOYEE_NOT_FOUND', 'The employee linked to this device user no longer exists.');
    }

    // A person presenting twice produces two events with different ids.
    // The first punch stands; the second is acknowledged, not applied.
    const finish = async (body) => {
      await updateShared(eventKey, { state: 'done', response: body }, EVENT_MEMORY_MS).catch(() => {});
      return res.status(200).json(body);
    };
    if (type === 'in' && row.checkIn) return await finish(accepted(row, type, true));
    if (type === 'out' && !row.checkIn) return await refuse(400, 'NOT_CHECKED_IN', 'No check-in is recorded for this employee today.');
    if (type === 'out' && row.checkOut) return await finish(accepted(row, type, true));

    const settings = await Settings.findById(company);
    // The server's clock stamps the punch; the device's was only checked.
    const punchTime = nowTimeIST();
    const shift = resolveShiftForToday(String(row.empId), settings);
    const details = `IoT device (${device.name}) · Face + Fingerprint`;
    const verificationRecord = {
      // The terminal performs its own biometric match; this app did not see
      // a face or a finger, so it records what was verified and by what.
      face: null,
      gps: null,
      liveness: { verified: false, reason: 'device-terminal' },
      source: 'iot-device',
      method: REQUIRED_VERIFICATION,
      deviceId: device.deviceId,
      eventId,
      deviceTimestamp: new Date(at).toISOString(),
      verifiedAt: new Date().toISOString(),
    };
    const deviceInfo = { name: device.name, type: 'iot-device', browser: 'Attendance machine', os: device.deviceId };
    const ip = clientIp(req);
    const side = type === 'in' ? 'checkIn' : 'checkOut';
    const patch = {
      [side]: punchTime,
      status: type === 'in'
        ? (isLate(punchTime, shift) ? 'late' : 'present')
        // A machine cannot ask for an early check-out reason, so an early
        // check-out is accepted and marked as such.
        : (isHalfDay(row.checkIn, punchTime, shift) ? 'half-day' : isEarlyExit(punchTime, shift) ? 'early-exit' : row.status),
      ...(type === 'out' ? { workedMinutes: workedMinutesBetween(row.checkIn, punchTime) } : {}),
      [`${side}Details`]: details,
      [`${side}DeviceId`]: device.deviceId,
      [`${side}Device`]: deviceInfo,
      [`${side}Ip`]: ip,
      [`${side}Loc`]: place.loc,
      [`${side}Address`]: place.address,
      [`${side}Location`]: place.structured,
      [`${side}Accuracy`]: place.accuracy,
      [`${side}Verification`]: verificationRecord,
    };

    // Conditional update, so two events arriving together produce one punch.
    const guard = type === 'in' ? { checkIn: null } : { checkOut: null, checkIn: { $ne: null } };
    const updated = await Attendance.findOneAndUpdate({ _id: row._id, company, ...guard }, patch, { new: true });
    if (!updated) {
      const current = await Attendance.findById(row._id);
      return await finish(accepted(current, type, true));
    }

    await logAudit(req, {
      action: type === 'in' ? 'Attendance check-in' : 'Attendance check-out',
      subject: updated.name,
      details,
      before: row,
      after: updated,
      actor: { name: `Device: ${device.name} (${device.deviceId})`, role: 'Device' },
      company,
    });
    Device.updateOne({ _id: device._id }, { lastSeenAt: new Date() }).catch(() => {});

    if (type === 'in' && updated.status === 'late') {
      await notifyAttendanceEvent({
        empId: updated.empId,
        title: 'Late Check-in',
        message: `${updated.name} checked in late today at ${updated.checkIn} (${device.name}).`,
        company,
      });
    }
    return await finish(accepted(updated, type, false));
  } catch (err) {
    await removeShared(eventKey).catch(() => {});
    logger.error('[device-punch] %s: %s', device.deviceId, err.message);
    return fail(res, 500, 'SERVER_ERROR', 'The punch could not be recorded. Send it again with the same eventId.');
  }
});

export default router;
