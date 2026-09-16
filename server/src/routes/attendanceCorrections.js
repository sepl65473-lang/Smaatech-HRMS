import { Router } from 'express';
import mongoose from 'mongoose';
import AttendanceCorrection from '../models/AttendanceCorrection.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Holiday from '../models/Holiday.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { sendNotification } from '../lib/notificationService.js';
import { resolveShiftForToday, isLate, isEarlyExit, isHalfDay } from '../lib/shifts.js';
import { isHoliday } from '../lib/holidays.js';
import { getSettingsDoc } from './settings.js';

const router = Router();
router.use(requireAuth);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Derives the attendance status a corrected day should actually carry.
 *
 * The previous approve handler hardcoded `status = 'present'`. A correction
 * for 11:30-14:00 against a 09:00-18:00 shift therefore became a full present
 * day — an employee could file a correction for any two times at all and be
 * marked fully present, with the lateness, early-exit and half-day rules that
 * apply to every other punch simply skipped. Payroll LOP is computed from
 * these statuses, so that was a paid-time error, not a cosmetic one.
 */
export function deriveCorrectedStatus({ checkIn, checkOut, shift, isHolidayDate = false }) {
  if (isHolidayDate) return 'holiday';
  if (!checkIn) return 'absent';
  if (checkOut && isHalfDay(checkIn, checkOut, shift)) return 'half-day';
  if (checkOut && isEarlyExit(checkOut, shift)) return 'early-exit';
  return isLate(checkIn, shift) ? 'late' : 'present';
}

// List corrections (scoped by company)
router.get('/', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);

  const scope = { ...companyFilter(req) };
  if (!isHR) {
    if (!req.auth.employeeId) return res.json([]);
    scope.employeeId = req.auth.employeeId;
  }

  const rows = await AttendanceCorrection.find(scope).sort({ createdAt: -1 }).limit(200);
  res.json(rows);
});

// Submit a correction request
router.post('/', async (req, res) => {
  const { employeeId, date, requestedCheckIn, requestedCheckOut, reason } = req.body || {};

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR && String(employeeId) !== String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only request corrections for yourself.' } });
  }
  if (!employeeId || !mongoose.Types.ObjectId.isValid(String(employeeId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid employeeId is required.' } });
  }

  // The previous handler took date and both times straight from the body with
  // no validation, so "99:99" or an arbitrary string was stored and then
  // written onto a real attendance row on approval.
  if (!ISO_DATE.test(String(date || ''))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'date must be YYYY-MM-DD.' } });
  }
  if (!HHMM.test(String(requestedCheckIn || '')) || !HHMM.test(String(requestedCheckOut || ''))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'requestedCheckIn and requestedCheckOut must be HH:MM (24-hour).' } });
  }
  if (!String(reason || '').trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required for an attendance correction.' } });
  }
  if (date > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: { code: 'FUTURE_DATE', message: 'Attendance cannot be corrected for a future date.' } });
  }

  // Employee name comes from the record, never the request body.
  const employee = await Employee.findOne({ _id: employeeId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const duplicate = await AttendanceCorrection.findOne({
    employeeId, date, status: 'Pending', ...companyFilter(req),
  });
  if (duplicate) {
    return res.status(409).json({ error: { code: 'DUPLICATE_REQUEST', message: 'A correction request for that date is already awaiting review.' } });
  }

  const created = await AttendanceCorrection.create({
    employeeId,
    employeeName: employee.name,
    date,
    requestedCheckIn,
    requestedCheckOut,
    reason: String(reason).slice(0, 1000),
    company: req.auth.company,
  });

  await logAudit(req, { action: 'Attendance correction requested', subject: employee.name, after: created });

  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'Attendance Correction Requested',
        message: `${employee.name} requested a correction for ${date} (In: ${requestedCheckIn}, Out: ${requestedCheckOut}).`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app', 'email'],
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Failed to notify HR of correction request:', err);
  }

  res.status(201).json(created);
});

// Approve correction request
router.post('/:id/approve', requireRole('HR Manager'), async (req, res) => {
  const correction = await AttendanceCorrection.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!correction) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Correction request not found.' } });
  }

  // Self-approval: an HR Manager could previously file a correction for their
  // own attendance and approve it themselves, which is the same hole that
  // existed in leave approval.
  if (req.auth.employeeId && String(correction.employeeId) === String(req.auth.employeeId)) {
    return res.status(403).json({
      error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot approve your own attendance correction.' },
    });
  }

  // Conditional transition so two reviewers can't both approve.
  const claimed = await AttendanceCorrection.findOneAndUpdate(
    { _id: correction._id, status: 'Pending', ...companyFilter(req) },
    { status: 'Approved', reviewedBy: req.auth.name || req.auth.role, reviewedAt: new Date(), reviewNote: req.body?.note || '' },
    { new: true },
  );
  if (!claimed) {
    return res.status(409).json({ error: { code: 'ALREADY_PROCESSED', message: 'Request already processed.' } });
  }

  const before = correction.toObject();

  // Recompute the resulting status from the SAME shift, lateness, early-exit
  // and half-day rules every other punch goes through, instead of assuming
  // 'present'.
  const settings = await getSettingsDoc(correction.company);
  const shift = resolveShiftForToday(String(correction.employeeId), settings);
  const holidays = await Holiday.find({ company: correction.company });
  const status = deriveCorrectedStatus({
    checkIn: correction.requestedCheckIn,
    checkOut: correction.requestedCheckOut,
    shift,
    isHolidayDate: isHoliday(correction.date, holidays),
  });

  const emp = await Employee.findById(correction.employeeId);
  const attendancePatch = {
    checkIn: correction.requestedCheckIn,
    checkOut: correction.requestedCheckOut,
    status,
    checkInDetails: 'Manual Correction (Approved)',
    checkOutDetails: 'Manual Correction (Approved)',
    // A corrected day carries no biometric evidence. Leaving a previous
    // punch's face/GPS verification attached to overwritten times would make
    // a hand-entered record look biometrically verified in the audit trail.
    checkInVerification: { corrected: true, approvedBy: req.auth.name || req.auth.role, approvedAt: new Date().toISOString(), face: null, gps: null, liveness: { verified: false, reason: 'manual-correction' } },
    checkOutVerification: { corrected: true, approvedBy: req.auth.name || req.auth.role, approvedAt: new Date().toISOString(), face: null, gps: null, liveness: { verified: false, reason: 'manual-correction' } },
    checkInFaceConfidence: null,
    checkOutFaceConfidence: null,
  };

  const existing = await Attendance.findOne({
    empId: correction.employeeId,
    date: correction.date,
    company: correction.company,
  });

  let attendanceAfter;
  if (existing) {
    attendanceAfter = await Attendance.findOneAndUpdate(
      { _id: existing._id },
      { ...attendancePatch, $addToSet: { anomalyFlags: 'manually-corrected' } },
      { new: true },
    );
  } else {
    try {
      attendanceAfter = await Attendance.create({
        empId: correction.employeeId,
        name: emp ? emp.name : correction.employeeName,
        dept: emp ? emp.dept : 'General',
        date: correction.date,
        company: correction.company,
        anomalyFlags: ['manually-corrected'],
        ...attendancePatch,
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      attendanceAfter = await Attendance.findOneAndUpdate(
        { empId: correction.employeeId, date: correction.date, company: correction.company },
        attendancePatch,
        { new: true },
      );
    }
  }

  await logAudit(req, {
    action: 'Attendance correction approved',
    subject: correction.employeeName,
    details: `${correction.date}: ${correction.requestedCheckIn}-${correction.requestedCheckOut} recalculated as "${status}" against shift ${shift.name} (${shift.start}-${shift.end})`,
    before,
    after: claimed,
  });

  try {
    const user = await User.findOne({ employeeId: correction.employeeId, company: correction.company });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'Attendance Correction Approved',
        message: `Your attendance correction for ${correction.date} was approved and recorded as "${status}".`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app'],
        company: correction.company,
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.json({ ...claimed.toJSON(), derivedStatus: status, attendance: attendanceAfter });
});

// Reject correction request
router.post('/:id/reject', requireRole('HR Manager'), async (req, res) => {
  const correction = await AttendanceCorrection.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!correction) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Correction request not found.' } });
  }
  if (req.auth.employeeId && String(correction.employeeId) === String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot decide your own attendance correction.' } });
  }

  // Recorded when supplied; not enforced, because client/src/data/store.js
  // calls `reject: (id) => apiFetch(..., { method: 'POST' })` with no body.
  // See the same note in routes/leave.js.
  const note = String(req.body?.note || '').trim();

  const before = correction.toObject();
  const claimed = await AttendanceCorrection.findOneAndUpdate(
    { _id: correction._id, status: 'Pending', ...companyFilter(req) },
    { status: 'Rejected', reviewedBy: req.auth.name || req.auth.role, reviewedAt: new Date(), reviewNote: note },
    { new: true },
  );
  if (!claimed) {
    return res.status(409).json({ error: { code: 'ALREADY_PROCESSED', message: 'Request already processed.' } });
  }

  await logAudit(req, { action: 'Attendance correction rejected', subject: correction.employeeName, details: note, before, after: claimed });

  try {
    const user = await User.findOne({ employeeId: correction.employeeId, company: correction.company });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'Attendance Correction Rejected',
        message: `Your attendance correction for ${correction.date} was rejected. Reason: ${note}`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app'],
        company: correction.company,
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.json(claimed);
});

export default router;
