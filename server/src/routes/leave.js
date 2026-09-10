import { Router } from 'express';
import Leave from '../models/Leave.js';
import Attendance from '../models/Attendance.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { runInTransaction } from '../lib/transactionHelper.js';
import { validate } from '../middleware/validation.js';
import { fileLeaveSchema } from '../validations/leaveValidation.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import User from '../models/User.js';
import Holiday from '../models/Holiday.js';
import { sendNotification, resolveChannels, fillTemplate } from '../lib/notificationService.js';
import { dateRangeInclusive, calculateWorkingDays } from '../lib/dateUtils.js';

// Marks every date in an approved leave as Attendance status 'leave' —
// upserts the row (mirrors attendanceCorrections.js's approve handler) since
// there's no guarantee the daily row-creation job has already run for a
// future-dated leave. Never overwrites a day the employee already genuinely
// checked into (e.g. leave approved retroactively after they'd come in).
async function markLeaveOnAttendance(leave) {
  const targetStatus = leave.isHalfDay ? 'half-day' : 'leave';
  await runInTransaction(async (session) => {
    const opts = session ? { session } : {};
    for (const date of dateRangeInclusive(leave.start, leave.end)) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await Attendance.findOne({ empId: leave.empId, date, company: leave.company }, null, opts);
      if (existing) {
        if (!existing.checkIn) {
          existing.status = targetStatus;
          // eslint-disable-next-line no-await-in-loop
          await existing.save(opts);
        }
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          await Attendance.create([{
            empId: leave.empId, name: leave.name, dept: leave.dept, date, status: targetStatus, company: leave.company,
          }], opts);
        } catch (err) {
          // Unique (empId, date) index — the daily job or another request
          // created this row in the meantime. Safe to leave as-is.
          if (err.code !== 11000) throw err;
        }
      }
    }
  });
}

// Falls back to this sequence when HR hasn't configured Settings > Workflows
// yet — matches the default the Workflows page itself shows unconfigured.
const DEFAULT_STAGES = ['HR Manager', 'HR Director'];

function stagesFor(leave) {
  return leave.approvalStages?.length ? leave.approvalStages : DEFAULT_STAGES;
}

const router = Router();
router.use(requireAuth);

/**
 * @openapi
 * /api/v1/leaves:
 *   get:
 *     summary: List leave applications
 *     tags: [Leaves]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of leave records or paginated object
 */
router.get('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const scope = { ...companyFilter(req), ...(isManager ? {} : { empId: req.auth.employeeId }) };
  const { page, limit, status } = req.query;

  const filter = { ...scope };
  if (status) filter.status = status;

  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const rows = await Leave.find(filter).sort({ createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(rows);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Leave.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Leave.countDocuments(filter),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
});

router.get('/:id', async (req, res) => {
  const row = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

// Any authenticated user may file their own leave request (see MyDashboard's
// employee self-service flow); only HR Manager/Director can file on behalf
// of someone else. Self-service requests are always created 'pending' —
// `status` is never taken from the request body, so an employee can't
// submit an already-'approved' request for themselves.
router.post('/', validate(fileLeaveSchema), async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const { empId, name, dept, type, start, end, reason, isHalfDay, halfDayTiming, attachment } = req.body || {};
  if (!isManager && empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file leave for yourself.' } });
  }

  // 1. Overlapping Leave Request Validation
  const existingOverlap = await Leave.findOne({
    empId,
    company: req.auth.company,
    status: { $in: ['pending', 'approved'] },
    $or: [
      { start: { $lte: end }, end: { $gte: start } },
    ],
  });
  if (existingOverlap) {
    return res.status(409).json({
      error: {
        code: 'OVERLAPPING_LEAVE',
        message: `An active leave request already exists between ${existingOverlap.start} and ${existingOverlap.end}.`,
      },
    });
  }

  const settingsDoc = await getSettingsDoc(req.auth.company);

  // 2. Working Days Calculation (excluding company weekends and holidays)
  const holidays = await Holiday.find({ company: req.auth.company });
  const holidaySet = new Set(holidays.map((h) => h.date));
  const calcWorkingDays = calculateWorkingDays(start, end, settingsDoc.workWeek || '5-day', holidaySet);
  const workingDays = isHalfDay ? 0.5 : calcWorkingDays;

  const created = await Leave.create({
    empId, name, dept, type, start, end, reason,
    attachment: attachment || '',
    isHalfDay: Boolean(isHalfDay),
    halfDayTiming: isHalfDay ? (halfDayTiming || 'first-half') : '',
    workingDays,
    company: req.auth.company,
    approvalStages: settingsDoc.approvalWorkflows?.leave?.length ? settingsDoc.approvalWorkflows.leave : DEFAULT_STAGES,
    currentStage: 0,
    ...(isManager ? { status: req.body?.status } : {}),
  });
  await logAudit(req, { action: 'Leave requested', subject: created.name, after: created });

  // Notify HR Managers
  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    const channels = resolveChannels(settingsDoc, 'leave');
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'New Leave Request',
        message: `${created.name} (${created.dept}) has filed a ${created.isHalfDay ? 'half-day ' : ''}${created.type} leave request from ${created.start} to ${created.end}.`,
        type: 'leave',
        actionUrl: '/leave',
        channels,
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave requested notifications:', err);
  }

  res.status(201).json(created);
});

// Self-service withdrawal for pending requests owned by the employee (or Admin)
router.post('/:id/withdraw', async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  const isOwner = req.auth.employeeId && String(leave.empId) === String(req.auth.employeeId);
  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only withdraw your own pending leave request.' } });
  }

  if (leave.status !== 'pending') {
    return res.status(400).json({ error: { code: 'CANNOT_WITHDRAW', message: 'Only pending leave requests can be withdrawn.' } });
  }

  const before = leave.toObject ? leave.toObject() : JSON.parse(JSON.stringify(leave));
  leave.status = 'withdrawn';
  await leave.save();

  await logAudit(req, { action: 'Leave withdrawn', subject: leave.name, before, after: leave });
  res.json(leave);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  const updated = await Leave.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  await logAudit(req, { action: 'Leave updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

// Stage-aware approve/decline — the caller must hold the role the request's
// current stage requires (HR Director always may, as the app-wide superuser).
// Approving the last stage is what actually flips status to 'approved';
// approving an earlier one just advances currentStage and stays 'pending'.
router.post('/:id/approve', async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }
  const stages = stagesFor(leave);
  const requiredRole = stages[leave.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = leave.toObject ? leave.toObject() : JSON.parse(JSON.stringify(leave));
  leave.approvals.push({ role: req.auth.role, decision: 'approved' });
  leave.currentStage += 1;
  if (leave.currentStage >= stages.length) leave.status = 'approved';
  await leave.save();

  await logAudit(req, { 
    action: `Leave ${leave.status === 'approved' ? 'approved' : 'stage approved'}`, 
    subject: leave.name, 
    before, 
    after: leave 
  });

  // Final approval: mark the leave dates on Attendance and notify the employee.
  if (leave.status === 'approved') {
    try {
      await markLeaveOnAttendance(leave);
    } catch (err) {
      console.error('Error marking leave on attendance:', err);
    }

    try {
      const recipientUser = await User.findOne({ employeeId: leave.empId });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: 'Leave Request Approved',
          message: `Your ${leave.type} leave request from ${leave.start} to ${leave.end} has been approved and marked on your attendance.`,
          type: 'leave',
          actionUrl: '/leave',
          channels: resolveChannels(settingsDoc, 'leave'),
          emailOverride: fillTemplate(settingsDoc.notificationTemplates?.email?.leaveApproval, {
            employee: leave.name,
            date: `${leave.start} to ${leave.end}`,
          }),
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending leave approved notification:', err);
    }
  }

  res.json(leave);
});

router.post('/:id/decline', async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }
  const stages = stagesFor(leave);
  const requiredRole = stages[leave.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = leave.toObject ? leave.toObject() : JSON.parse(JSON.stringify(leave));
  leave.approvals.push({ role: req.auth.role, decision: 'declined' });
  leave.status = 'declined';
  await leave.save();

  await logAudit(req, { action: 'Leave declined', subject: leave.name, before, after: leave });

  // Notify Employee on decline
  try {
    const recipientUser = await User.findOne({ employeeId: leave.empId });
    if (recipientUser) {
      const settingsDoc = await getSettingsDoc(req.auth.company);
      await sendNotification({
        recipientId: recipientUser._id,
        title: 'Leave Request Declined',
        message: `Your ${leave.type} leave request from ${leave.start} to ${leave.end} has been declined.`,
        type: 'leave',
        actionUrl: '/leave',
        channels: resolveChannels(settingsDoc, 'leave'),
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave declined notification:', err);
  }

  res.json(leave);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await Leave.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Leave deleted', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
