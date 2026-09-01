import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import DeviceUserMapping from '../models/DeviceUserMapping.js';
import Settings from '../models/Settings.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay, nowTimeIST } from '../lib/shifts.js';
import { logAudit } from '../lib/auditLogger.js';
import { todayISO } from '../lib/dateUtils.js';
import { notifyAttendanceEvent } from '../lib/attendanceNotify.js';

const router = Router();

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
  if (!settings?.biometricDeviceApiKey || settings.biometricDeviceApiKey !== key) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid device key.' } });
  }
  req.deviceCompany = company;
  next();
}

// The real, working HTTP surface a biometric-terminal bridge (e.g. a
// node-zklib process polling a ZKTeco/eSSL device) could call — the vendor
// TCP protocol itself isn't built here (needs physical hardware to develop
// and test against), but everything from here on applies the punch with
// the same server-computed lateness/half-day logic and audit trail as every
// other check-in path in this app, not the loose HR-override PATCH the old
// simulated Integrations.jsx reconciliation flow used.
router.post('/', requireDeviceKey, async (req, res) => {
  const { deviceId, deviceUserId, type, time } = req.body || {};
  const company = req.deviceCompany;
  if (!deviceId || !deviceUserId || !['in', 'out'].includes(type)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'deviceId, deviceUserId, and type ("in"|"out") are required.' } });
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

  const settings = await Settings.findById(company);
  const punchTime = time || nowTimeIST();
  const shift = resolveShiftForToday(String(row.empId), settings);

  const patch = type === 'in'
    ? {
        checkIn: punchTime,
        status: isLate(punchTime, shift) ? 'late' : 'present',
        checkInDetails: `Biometric device (${deviceId})`,
        checkInDeviceId: deviceId,
      }
    : {
        checkOut: punchTime,
        status: isHalfDay(row.checkIn, punchTime, shift)
          ? 'half-day'
          : isEarlyExit(punchTime, shift) ? 'early-exit' : row.status,
        checkOutDetails: `Biometric device (${deviceId})`,
        checkOutDeviceId: deviceId,
      };

  const updated = await Attendance.findByIdAndUpdate(row._id, patch, { new: true });

  await logAudit(req, {
    action: type === 'in' ? 'Attendance check-in' : 'Attendance check-out',
    subject: updated.name,
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
