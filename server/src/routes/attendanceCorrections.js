import { Router } from 'express';
import AttendanceCorrection from '../models/AttendanceCorrection.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { sendNotification } from '../lib/notificationService.js';

const router = Router();
router.use(requireAuth);

// List corrections (scoped by company)
router.get('/', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  
  let scope = companyFilter(req);
  if (!isHR) {
    if (req.auth.employeeId) {
      scope.employeeId = req.auth.employeeId;
    } else {
      return res.json([]);
    }
  }

  const rows = await AttendanceCorrection.find(scope).sort({ createdAt: -1 });
  res.json(rows);
});

// Submit a correction request
router.post('/', async (req, res) => {
  const { employeeId, employeeName, date, requestedCheckIn, requestedCheckOut, reason } = req.body || {};
  
  // Regular employees can only submit for themselves
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR && String(employeeId) !== String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only request corrections for yourself.' } });
  }

  const created = await AttendanceCorrection.create({
    employeeId,
    employeeName,
    date,
    requestedCheckIn,
    requestedCheckOut,
    reason,
    company: req.auth.company
  });

  await logAudit(req, { action: 'Attendance correction requested', subject: employeeName, after: created });

  // Notify HR Managers of request
  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'Attendance Correction Requested',
        message: `${employeeName} requested correction for ${date} (In: ${requestedCheckIn}, Out: ${requestedCheckOut}).`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app', 'email'],
        company: req.auth.company
      });
    }
  } catch (err) {
    console.error('Failed to notify HR of correction request:', err);
  }

  res.status(201).json(created);
});

// Approve correction request
router.post('/:id/approve', requireRole('HR Manager'), async (req, res) => {
  const correction = await AttendanceCorrection.findById(req.params.id);
  if (!correction) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Correction request not found.' } });
  }

  if (correction.status !== 'Pending') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request already processed.' } });
  }

  const before = JSON.parse(JSON.stringify(correction));
  correction.status = 'Approved';
  await correction.save();

  // Lifecycle Sync: Auto-update or insert Attendance record
  let attendance = await Attendance.findOne({ empId: correction.employeeId, date: correction.date });
  if (attendance) {
    attendance.checkIn = correction.requestedCheckIn;
    attendance.checkOut = correction.requestedCheckOut;
    attendance.status = 'present';
    attendance.checkInDetails = 'Manual Correction (Approved)';
    attendance.checkOutDetails = 'Manual Correction (Approved)';
    await attendance.save();
  } else {
    const emp = await Employee.findById(correction.employeeId);
    await Attendance.create({
      empId: correction.employeeId,
      name: emp ? emp.name : correction.employeeName,
      dept: emp ? emp.dept : 'General',
      date: correction.date,
      checkIn: correction.requestedCheckIn,
      checkOut: correction.requestedCheckOut,
      status: 'present',
      checkInDetails: 'Manual Correction (Approved)',
      checkOutDetails: 'Manual Correction (Approved)',
      company: correction.company
    });
  }

  await logAudit(req, { action: 'Attendance correction approved', subject: correction.employeeName, before, after: correction });

  // Notify employee of approval
  try {
    const user = await User.findOne({ employeeId: correction.employeeId });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'Attendance Correction Approved',
        message: `Your attendance correction request for ${correction.date} has been approved.`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app'],
        company: correction.company
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.json(correction);
});

// Reject correction request
router.post('/:id/reject', requireRole('HR Manager'), async (req, res) => {
  const correction = await AttendanceCorrection.findById(req.params.id);
  if (!correction) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Correction request not found.' } });
  }

  if (correction.status !== 'Pending') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request already processed.' } });
  }

  const before = JSON.parse(JSON.stringify(correction));
  correction.status = 'Rejected';
  await correction.save();

  await logAudit(req, { action: 'Attendance correction rejected', subject: correction.employeeName, before, after: correction });

  // Notify employee of rejection
  try {
    const user = await User.findOne({ employeeId: correction.employeeId });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'Attendance Correction Rejected',
        message: `Your attendance correction request for ${correction.date} has been rejected.`,
        type: 'system',
        actionUrl: '/attendance',
        channels: ['in-app'],
        company: correction.company
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.json(correction);
});

export default router;
