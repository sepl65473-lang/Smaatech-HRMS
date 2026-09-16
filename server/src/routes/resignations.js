import { Router } from 'express';
import mongoose from 'mongoose';
import Resignation from '../models/Resignation.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { runInTransaction } from '../lib/transactionHelper.js';
import { logAudit } from '../lib/auditLogger.js';
import { sendNotification } from '../lib/notificationService.js';
import { terminateAllAccess } from '../lib/sessionRevoker.js';
import { todayISO } from '../lib/dateUtils.js';
import LifecycleEvent from '../models/LifecycleEvent.js';
import { employmentPolicy, addDays } from './lifecycle.js';

const router = Router();
router.use(requireAuth);

const CLEARANCE_DEPTS = ['IT', 'Finance', 'HR', 'Admin'];

// List resignations based on company scope and role permissions
router.get('/', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isFinance = req.auth.role === 'Finance Lead';
  
  let scope = companyFilter(req);
  if (!isHR && !isFinance) {
    // Regular employees can only see their own resignation
    if (req.auth.employeeId) {
      scope.employeeId = req.auth.employeeId;
    } else {
      return res.json([]);
    }
  }

  const { page, limit, status } = req.query;
  if (status) scope.status = status;

  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const rows = await Resignation.find(scope).sort({ createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(rows);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Resignation.find(scope).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Resignation.countDocuments(scope),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
});

// Submit a new resignation
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// A resignation is "live" until the exit is finished — these are the states in
// which a second one must not be accepted.
const OPEN_STATUSES = ['Submitted', 'Approved'];

router.post('/', async (req, res) => {
  const { employeeId, resignationDate, requestedLastWorkingDay, reason } = req.body || {};

  // Regular employees can only submit resignation for themselves
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR && String(employeeId) !== String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file resignation for yourself.' } });
  }

  if (!employeeId || !mongoose.Types.ObjectId.isValid(String(employeeId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'employeeId is not a valid id.' } });
  }
  if (!String(reason || '').trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason for leaving is required.' } });
  }

  const filedOn = ISO_DATE.test(String(resignationDate || '')) ? String(resignationDate) : todayISO();
  if (!ISO_DATE.test(String(requestedLastWorkingDay || ''))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'requestedLastWorkingDay must be a YYYY-MM-DD date.' } });
  }
  // A last working day BEFORE the resignation date would make the notice
  // period negative and the exit timeline nonsensical.
  if (String(requestedLastWorkingDay) < filedOn) {
    return res.status(400).json({
      error: { code: 'INVALID_LAST_WORKING_DAY', message: 'The last working day cannot be before the resignation date.' },
    });
  }

  // Identity comes from the employee RECORD, never from the request body —
  // otherwise a resignation can carry someone else's name into the exit
  // cockpit, the HR notification and the audit trail.
  const employee = await Employee.findOne({ _id: employeeId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  // One live exit per person. Without this an employee could file any number
  // of resignations, each spawning its own clearance checklist and F&F
  // settlement — several payable exits for one departure.
  const existing = await Resignation.findOne({
    employeeId,
    company: req.auth.company,
    status: { $in: OPEN_STATUSES },
  });
  if (existing) {
    return res.status(409).json({
      error: {
        code: 'RESIGNATION_ALREADY_OPEN',
        message: `An exit is already in progress for ${employee.name} (filed ${existing.resignationDate}).`,
        existingId: String(existing._id),
      },
    });
  }

  // The notice period is company configuration (Settings.employmentPolicy),
  // and it is shorter on probation at most companies — so which one applies
  // depends on the employee's own stage. A shortfall is REPORTED, not blocked:
  // whether to waive notice is an HR decision, and the exit record should say
  // plainly that it was short rather than silently accepting it.
  const policy = await employmentPolicy(req.auth.company);
  const onProbation = employee.employmentStage === 'Probation';
  const requiredNoticeDays = onProbation ? policy.noticePeriodDaysOnProbation : policy.noticePeriodDays;
  const earliestCompliantLWD = addDays(filedOn, requiredNoticeDays);
  const noticeShortfallDays = requiredNoticeDays > 0 && requestedLastWorkingDay < earliestCompliantLWD
    ? Math.max(0, Math.round(
      (Date.parse(`${earliestCompliantLWD}T00:00:00Z`) - Date.parse(`${requestedLastWorkingDay}T00:00:00Z`)) / 86400000,
    ))
    : 0;

  // Pre-load default clearances list
  const clearances = CLEARANCE_DEPTS.map(dept => ({
    dept,
    status: 'Pending',
    approvedBy: '',
    approvedAt: '',
    notes: ''
  }));

  const created = await Resignation.create({
    employeeId,
    employeeName: employee.name,
    resignationDate: filedOn,
    requestedLastWorkingDay,
    reason: String(reason).slice(0, 2000),
    clearances,
    noticePolicyDays: requiredNoticeDays,
    earliestCompliantLastWorkingDay: earliestCompliantLWD,
    noticeShortfallDays,
    company: req.auth.company
  });

  // Moving to notice period is a lifecycle event like any other, so the
  // employment history shows the whole arc rather than stopping at hire.
  await LifecycleEvent.create({
    company: req.auth.company,
    empId: employee._id,
    employeeName: employee.name,
    type: 'notice-started',
    effectiveDate: filedOn,
    changes: {
      employmentStage: { from: employee.employmentStage || null, to: 'Notice Period' },
    },
    reason: String(reason).slice(0, 500),
    note: noticeShortfallDays
      ? `Requested last working day is ${noticeShortfallDays} day(s) short of the ${requiredNoticeDays}-day notice period`
      : `${requiredNoticeDays}-day notice period`,
    dedupeKey: `notice-started:${created._id}`,
    actor: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
  }).catch(() => { /* history must not fail the resignation itself */ });

  await Employee.updateOne(
    { _id: employee._id, company: req.auth.company },
    { employmentStage: 'Notice Period' },
  );

  await logAudit(req, { action: 'Resignation filed', subject: employee.name, after: created });

  // Notify HR Managers of the resignation
  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'New Resignation Filed',
        message: `${employee.name} has submitted resignation. Last working day requested: ${requestedLastWorkingDay}.`,
        type: 'system',
        actionUrl: '/resignations',
        channels: ['in-app', 'email'],
        company: req.auth.company
      });
    }
  } catch (err) {
    console.error('Failed to send resignation alerts:', err);
  }

  res.status(201).json(created);
});

// Sign-off on clearance check
router.post('/:id/clearance', async (req, res) => {
  const { dept, status, notes } = req.body || {};
  
  if (!CLEARANCE_DEPTS.includes(dept)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid clearance department.' } });
  }
  // `status` went straight onto the record unvalidated, so any string at all
  // could be stored as a clearance outcome.
  if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Clearance status must be Pending, Approved or Rejected.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  // Permission checks
  const isIT = req.auth.role === 'IT Support' || ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isFinance = req.auth.role === 'Finance Lead' || ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);

  if (dept === 'IT' && !isIT) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only IT/HR can sign off IT clearance.' } });
  if (dept === 'Finance' && !isFinance) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance/HR can sign off Finance clearance.' } });
  if ((dept === 'HR' || dept === 'Admin') && !isHR) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR can sign off HR/Admin clearances.' } });

  const before = JSON.parse(JSON.stringify(resignation));
  
  // Update target clearance record
  resignation.clearances = resignation.clearances.map(c => {
    if (c.dept === dept) {
      return {
        dept,
        status,
        notes: notes || '',
        approvedBy: req.auth.name || req.auth.role,
        approvedAt: new Date().toISOString().slice(0, 10)
      };
    }
    return c;
  });

  await resignation.save();
  await logAudit(req, { action: `Clearance signed off (${dept})`, subject: resignation.employeeName, before, after: resignation });

  res.json(resignation);
});

// Process/Draft Full & Final (FnF) Settlement calculations
router.post('/:id/fnf', async (req, res) => {
  const isFinance = req.auth.role === 'Finance Lead' || req.auth.role === 'HR Director';
  if (!isFinance) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance Lead or HR Director can calculate FnF.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  const before = JSON.parse(JSON.stringify(resignation));
  const data = req.body || {};

  const monthlySalary = Number(data.monthlySalary) || 0;
  const leaveEncashment = Number(data.leaveEncashment) || 0;
  const gratuity = Number(data.gratuity) || 0;
  const otherAllowances = Number(data.otherAllowances) || 0;
  const loansDeduction = Number(data.loansDeduction) || 0;
  const assetDeduction = Number(data.assetDeduction) || 0;
  const otherDeductions = Number(data.otherDeductions) || 0;

  const netPayout = (monthlySalary + leaveEncashment + gratuity + otherAllowances) - (loansDeduction + assetDeduction + otherDeductions);

  resignation.fnfSettlement = {
    monthlySalary,
    leaveEncashment,
    gratuity,
    otherAllowances,
    loansDeduction,
    assetDeduction,
    otherDeductions,
    netPayout,
    status: 'Processed',
    processedAt: new Date().toISOString().slice(0, 10),
    notes: data.notes || ''
  };

  await resignation.save();
  await logAudit(req, { action: 'FnF Settlement Processed', subject: resignation.employeeName, before, after: resignation });

  res.json(resignation);
});

// Pay Full & Final (FnF) Settlement and terminate employee status
// Idempotency-Key is honoured but not mandatory: the real double-payout guard
// is the state machine below (a settlement must be 'Processed' to be paid, and
// paying moves it to 'Paid'), which works across processes. The in-memory
// idempotency store does not — it is per-worker.
router.post('/:id/fnf/pay', idempotency(), async (req, res) => {
  const isFinance = req.auth.role === 'Finance Lead' || req.auth.role === 'HR Director';
  if (!isFinance) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance Lead or HR Director can pay FnF.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  // Guard rails the old handler had none of: paying out a settlement that was
  // never calculated threw on `fnfSettlement.status` (undefined), paying twice
  // was possible, and an employee could be exited with clearances outstanding.
  if (!resignation.fnfSettlement || resignation.fnfSettlement.status !== 'Processed') {
    return res.status(400).json({
      error: { code: 'FNF_NOT_PROCESSED', message: 'Calculate the Full & Final settlement before paying it out.' },
    });
  }
  const outstanding = (resignation.clearances || []).filter((c) => c.status !== 'Approved').map((c) => c.dept);
  if (outstanding.length && req.body?.overrideClearances !== true) {
    return res.status(409).json({
      error: {
        code: 'CLEARANCES_PENDING',
        message: `Clearance is still outstanding from: ${outstanding.join(', ')}. Complete them, or resend with overrideClearances:true to proceed anyway.`,
        outstanding,
      },
    });
  }

  const before = JSON.parse(JSON.stringify(resignation));

  await runInTransaction(async (session) => {
    const opts = session ? { session } : {};
    resignation.fnfSettlement.status = 'Paid';
    resignation.status = 'Approved';
    if (!resignation.approvedLastWorkingDay) {
      resignation.approvedLastWorkingDay = resignation.requestedLastWorkingDay;
    }
    await resignation.save(opts);

    // Lifecycle automation: mark employee as exited, and disable credentials
    await Employee.findByIdAndUpdate(
      resignation.employeeId,
      { status: 'exited', employmentStage: 'Exited' },
      opts,
    );
    await User.findOneAndUpdate({ employeeId: resignation.employeeId }, { active: false, status: 'Inactive' }, opts);
  });

  // Deactivating the User row alone left the exited employee holding a valid
  // 15-minute access token (usable on every endpoint) and a 30-day refresh
  // token. Both classes are killed here.
  const exitedUser = await User.findOne({ employeeId: resignation.employeeId });
  if (exitedUser) {
    const revoked = await terminateAllAccess(exitedUser._id, { reason: 'F&F paid, employee exited' });
    await logAudit(req, {
      action: 'Exited employee access terminated',
      subject: resignation.employeeName,
      details: `${revoked} session(s) revoked and outstanding access tokens invalidated.`,
    });
  }

  await logAudit(req, { action: 'FnF Paid & Employee Terminated', subject: resignation.employeeName, before, after: resignation });

  // Notify employee of payment finalization
  try {
    const user = await User.findOne({ employeeId: resignation.employeeId });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'FnF Payout Processed',
        message: `Your Full & Final Settlement has been processed and paid out. Net Payout: ₹${resignation.fnfSettlement.netPayout}.`,
        type: 'system',
        actionUrl: '/resignations',
        channels: ['in-app', 'email'],
        company: resignation.company
      });
    }
  } catch (err) {
    console.error('Failed to notify employee of FnF pay:', err);
  }

  res.json(resignation);
});

// General update endpoint ( LWD updates or approve/reject status changes )
router.patch('/:id', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can modify resignation terms.' } });
  }

  const before = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  // Allow-list: the old handler passed req.body straight through, so an HR
  // Manager could set fnfSettlement.status to 'Paid' (skipping the payout
  // route's guards, the employee exit and the notification) or move the
  // record to another company.
  const PATCHABLE = ['approvedLastWorkingDay', 'requestedLastWorkingDay', 'reason', 'status', 'exitInterviewNotes'];
  const patch = {};
  for (const field of PATCHABLE) {
    if (req.body?.[field] !== undefined) patch[field] = req.body[field];
  }
  if (patch.status && !['Pending', 'Approved', 'Rejected', 'Withdrawn'].includes(patch.status)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unrecognised resignation status.' } });
  }

  const updated = await Resignation.findOneAndUpdate({ _id: req.params.id, ...companyFilter(req) }, patch, { new: true });
  await logAudit(req, { action: 'Resignation updated', subject: updated.employeeName, before, after: updated });

  // If approved LWD, let employee know
  if (req.body.approvedLastWorkingDay && req.body.approvedLastWorkingDay !== before.approvedLastWorkingDay) {
    try {
      const user = await User.findOne({ employeeId: updated.employeeId });
      if (user) {
        await sendNotification({
          recipientId: user._id,
          title: 'Resignation Terms Updated',
          message: `Your approved last working day has been set to ${req.body.approvedLastWorkingDay}.`,
          type: 'system',
          actionUrl: '/resignations',
          channels: ['in-app'],
          company: updated.company
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  res.json(updated);
});

export default router;
