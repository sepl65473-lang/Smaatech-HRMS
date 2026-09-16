import { Router } from 'express';
import mongoose from 'mongoose';
import Leave from '../models/Leave.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import LeaveType from '../models/LeaveType.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { runInTransaction } from '../lib/transactionHelper.js';
import { validate } from '../middleware/validation.js';
import { fileLeaveSchema, patchLeaveSchema, decisionSchema } from '../validations/leaveValidation.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import User from '../models/User.js';
import Holiday from '../models/Holiday.js';
import { sendNotification, resolveChannels, fillTemplate } from '../lib/notificationService.js';
import { dateRangeInclusive, calculateWorkingDays } from '../lib/dateUtils.js';
import { holidayDateSetForRange } from '../lib/holidays.js';
import LeaveLedger from '../models/LeaveLedger.js';
import {
  leaveYearOf, reserve, commit, release, adjust, balanceSheet, getLeaveType, ensureLeaveTypes,
} from '../lib/leaveLedger.js';

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

// Reverses the attendance marking when an APPROVED leave is later cancelled,
// so the days don't stay marked 'leave' on a roster the employee actually
// worked. Only touches days this leave itself marked.
async function unmarkLeaveOnAttendance(leave) {
  for (const date of dateRangeInclusive(leave.start, leave.end)) {
    // eslint-disable-next-line no-await-in-loop
    await Attendance.updateOne(
      { empId: leave.empId, date, company: leave.company, checkIn: null, status: { $in: ['leave', 'half-day'] } },
      { status: 'absent' },
    );
  }
}

// Falls back to this sequence when HR hasn't configured Settings > Workflows
// yet. 'Reporting Manager' is a STAGE, resolved at decision time against the
// requester's own Employee.managerId — not a global role, so any employee who
// happens to manage someone can approve for their own reports and nobody
// else's.
const DEFAULT_STAGES = ['Reporting Manager', 'HR Manager'];

function stagesFor(leave) {
  return leave.approvalStages?.length ? leave.approvalStages : DEFAULT_STAGES;
}

/**
 * Decides whether `req.auth` may act on the current stage of `leave`.
 *
 * Two rules that did not exist before:
 *
 *  - SELF-APPROVAL IS BLOCKED. Previously an HR Manager filing their own leave
 *    satisfied the 'HR Manager' stage themselves and could approve it in one
 *    click, and an HR Director could approve anything including their own.
 *  - A 'Reporting Manager' stage is satisfied only by THAT EMPLOYEE'S OWN
 *    manager, checked against Employee.managerId, so a manager cannot approve
 *    outside their team.
 */
async function canDecide(req, leave) {
  const stages = stagesFor(leave);
  const requiredStage = stages[leave.currentStage] || stages[stages.length - 1];

  const isOwnRequest = req.auth.employeeId && String(leave.empId) === String(req.auth.employeeId);
  if (isOwnRequest) {
    return { ok: false, requiredStage, code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot approve or decline your own leave request.' };
  }

  if (requiredStage === 'Reporting Manager') {
    const employee = await Employee.findOne({ _id: leave.empId, company: leave.company });
    const managerId = employee?.managerId ? String(employee.managerId) : null;
    if (managerId && req.auth.employeeId && String(req.auth.employeeId) === managerId) {
      return { ok: true, requiredStage, actingAs: 'Reporting Manager' };
    }
    // No manager on file, or someone else asking: HR may act as the fallback
    // so a request can never become permanently un-approvable.
    if (['HR Manager', 'HR Director'].includes(req.auth.role)) {
      return { ok: true, requiredStage, actingAs: `${req.auth.role} (manager stage fallback)` };
    }
    return { ok: false, requiredStage, code: 'FORBIDDEN', message: "Only this employee's reporting manager can decide this stage." };
  }

  if (req.auth.role === requiredStage) return { ok: true, requiredStage, actingAs: req.auth.role };
  // HR Director remains the escalation path for every other stage.
  if (req.auth.role === 'HR Director') return { ok: true, requiredStage, actingAs: 'HR Director (escalation)' };

  return { ok: false, requiredStage, code: 'FORBIDDEN', message: `This stage needs ${requiredStage} approval.` };
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
 *     responses:
 *       200:
 *         description: List of leave records or paginated object
 */
router.get('/', async (req, res) => {
  const isHR = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  let scope = { ...companyFilter(req) };

  if (!isHR) {
    // A reporting manager sees their own requests plus their direct reports'
    // — and nothing else. Previously a non-HR caller saw only their own, so
    // there was no way for a manager to review a team request at all.
    const reportIds = req.auth.employeeId
      ? (await Employee.find({ managerId: req.auth.employeeId, ...companyFilter(req) }).select('_id').lean()).map((e) => e._id)
      : [];
    const visible = [...reportIds];
    if (req.auth.employeeId) visible.push(new mongoose.Types.ObjectId(String(req.auth.employeeId)));
    if (!visible.length) return res.json([]);
    scope.empId = { $in: visible };
  }

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

// Configured leave policy for this company — quotas, accrual, paid/unpaid.
router.get('/types', async (req, res) => {
  // A retired type must not be offered for new requests, but HR configuring
  // policy needs to see it — otherwise a deactivated type becomes invisible
  // and can never be reactivated.
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const includeInactive = isHR && String(req.query.includeInactive) === 'true';
  res.json(await ensureLeaveTypes(req.auth.company, { includeInactive }));
});

/**
 * LEAVE POLICY CONFIGURATION.
 *
 * The quotas, accrual modes and carry-forward rules were seeded defaults that
 * nobody could change: DEFAULT_LEAVE_TYPES in models/LeaveType.js is a
 * reasonable starting point for an Indian company, but it is a guess about
 * THIS company's policy, and the product offered no way to correct it. That
 * left every balance in the system enforcing numbers HR never agreed to.
 *
 * These endpoints make the policy the company's own. They are deliberately
 * conservative about history: an existing type's code can never change (the
 * ledger references it), and a type with movement behind it is deactivated
 * rather than deleted.
 */
const EDITABLE_TYPE_FIELDS = [
  'name', 'annualQuota', 'accrualMode', 'paid', 'carryForward', 'carryForwardCap',
  'allowHalfDay', 'maxConsecutiveDays', 'documentRequiredAfterDays',
  'allowNegativeBalance', 'negativeBalanceLimit', 'active', 'sortOrder',
];

function sanitizeTypePayload(body = {}) {
  const clean = {};
  for (const field of EDITABLE_TYPE_FIELDS) {
    if (body[field] !== undefined) clean[field] = body[field];
  }
  return clean;
}

function validateTypePayload(payload) {
  if (payload.annualQuota !== undefined) {
    const quota = Number(payload.annualQuota);
    if (!Number.isFinite(quota) || quota < 0 || quota > 366) {
      return 'annualQuota must be between 0 and 366 days.';
    }
  }
  if (payload.accrualMode !== undefined && !['annual', 'monthly'].includes(payload.accrualMode)) {
    return "accrualMode must be 'annual' or 'monthly'.";
  }
  if (payload.carryForwardCap !== undefined && Number(payload.carryForwardCap) < 0) {
    return 'carryForwardCap cannot be negative.';
  }
  if (payload.name !== undefined && !String(payload.name).trim()) {
    return 'A leave type needs a name.';
  }
  return null;
}

router.post('/types', requireRole('HR Manager'), async (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(code)) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'code must be 2-31 characters: lowercase letters, digits or hyphens.' },
    });
  }
  const payload = sanitizeTypePayload(req.body);
  const problem = validateTypePayload(payload);
  if (problem) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: problem } });
  if (!payload.name) payload.name = code;

  try {
    const created = await LeaveType.create({ ...payload, code, company: req.auth.company });
    await logAudit(req, { action: 'Leave type created', subject: created.name, after: created });
    return res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: { code: 'DUPLICATE', message: `A leave type with code "${code}" already exists.` },
      });
    }
    throw err;
  }
});

router.patch('/types/:code', requireRole('HR Manager'), async (req, res) => {
  const code = String(req.params.code).toLowerCase();
  const existing = await LeaveType.findOne({ company: req.auth.company, code });
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave type not found.' } });

  const payload = sanitizeTypePayload(req.body);
  const problem = validateTypePayload(payload);
  if (problem) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: problem } });

  // `code` is the join key used by every Leave row, balance and ledger entry.
  // Renaming it would orphan all of them, so it is not editable — create a new
  // type and retire this one instead.
  const before = existing.toJSON();
  Object.assign(existing, payload);
  await existing.save();

  await logAudit(req, {
    action: 'Leave policy changed',
    subject: existing.name,
    before,
    after: existing,
    details: Object.keys(payload).join(', '),
  });

  // A quota change does NOT retroactively rewrite balances: the ledger is a
  // record of what actually happened. It applies at the next accrual or
  // rollover, which is why the response says so explicitly.
  res.json({
    ...existing.toJSON(),
    note: 'Existing balances are unchanged. The new policy applies from the next accrual or leave-year rollover; use POST /leaves/balance/adjust to correct a balance now.',
  });
});

router.delete('/types/:code', requireRole('HR Manager'), async (req, res) => {
  const code = String(req.params.code).toLowerCase();
  const existing = await LeaveType.findOne({ company: req.auth.company, code });
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave type not found.' } });

  // History must stay readable. A type people have actually taken leave under
  // is retired, not removed — deleting it would leave existing requests,
  // balances and ledger entries pointing at a type that no longer exists.
  const inUse = await Leave.countDocuments({ company: req.auth.company, type: code });
  if (inUse > 0) {
    existing.active = false;
    await existing.save();
    await logAudit(req, { action: 'Leave type retired', subject: existing.name, after: existing });
    return res.json({
      retired: true,
      type: existing.toJSON(),
      message: `${existing.name} has been used by ${inUse} request(s), so it was deactivated rather than deleted. It can no longer be selected for new requests.`,
    });
  }

  await LeaveType.deleteOne({ _id: existing._id });
  await logAudit(req, { action: 'Leave type deleted', subject: existing.name, before: existing });
  res.json({ deleted: true, code });
});

/**
 * Server-computed leave balance. The product previously had NO server-side
 * balance at all: the figure shown to employees was derived in the browser
 * from whatever leave rows the client happened to hold, and nothing on the
 * server ever checked it.
 */
router.get('/balance', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const requested = req.query.empId;

  let empId = req.auth.employeeId;
  if (requested && String(requested) !== String(req.auth.employeeId)) {
    if (!mongoose.Types.ObjectId.isValid(String(requested))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
    }
    const target = await Employee.findOne({ _id: requested, ...companyFilter(req) });
    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
    const isTheirManager = target.managerId && String(target.managerId) === String(req.auth.employeeId);
    if (!isHR && !isTheirManager) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You can only view your own team's leave balance." } });
    }
    empId = requested;
  }

  if (!empId) return res.status(400).json({ error: { code: 'NO_EMPLOYEE', message: 'Your login is not linked to an employee profile.' } });

  const settingsDoc = await getSettingsDoc(req.auth.company);
  const year = Number(req.query.year) || leaveYearOf(new Date().toISOString().slice(0, 10), settingsDoc.leaveYearStartMonth || 1);
  res.json({
    empId: String(empId),
    year,
    balances: await balanceSheet({ company: req.auth.company, empId, year }),
  });
});

// Immutable movement history behind a balance. An employee can see their own;
// HR can see anyone's. This is what makes "where did my 3 days go?" answerable.
router.get('/ledger', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const requested = req.query.empId;

  let empId = req.auth.employeeId;
  if (requested && String(requested) !== String(req.auth.employeeId)) {
    if (!isHR) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view your own leave ledger.' } });
    if (!mongoose.Types.ObjectId.isValid(String(requested))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
    }
    if (!(await Employee.exists({ _id: requested, ...companyFilter(req) }))) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
    }
    empId = requested;
  }
  if (!empId) return res.status(400).json({ error: { code: 'NO_EMPLOYEE', message: 'Your login is not linked to an employee profile.' } });

  const filter = { company: req.auth.company, empId };
  if (req.query.year) filter.year = Number(req.query.year);
  if (req.query.type) filter.type = String(req.query.type);

  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await LeaveLedger.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json(rows);
});

// Manual HR correction to a balance — always ledgered with the actor and a
// mandatory reason, so an adjustment is never an untraceable number change.
router.post('/balance/adjust', requireRole('HR Manager'), async (req, res) => {
  const { empId, type, days, note, year } = req.body || {};
  if (!empId || !mongoose.Types.ObjectId.isValid(String(empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'A valid empId is required.' } });
  }
  const delta = Number(days);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 365) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'days must be a non-zero number within +/- 365.' } });
  }
  if (!String(note || '').trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required for a manual leave-balance adjustment.' } });
  }
  const employee = await Employee.findOne({ _id: empId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const leaveType = await getLeaveType(req.auth.company, type);
  if (!leaveType) return res.status(400).json({ error: { code: 'UNKNOWN_LEAVE_TYPE', message: `"${type}" is not a configured leave type.` } });

  const settingsDoc = await getSettingsDoc(req.auth.company);
  const targetYear = Number(year) || leaveYearOf(new Date().toISOString().slice(0, 10), settingsDoc.leaveYearStartMonth || 1);

  const result = await adjust({
    company: req.auth.company,
    empId, year: targetYear, type,
    days: delta,
    actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
    note: String(note).slice(0, 500),
  });
  if (!result.ok) return res.status(400).json({ error: { code: result.reason, message: 'Adjustment failed.' } });

  await logAudit(req, {
    action: 'Leave balance adjusted',
    subject: employee.name,
    details: `${delta > 0 ? '+' : ''}${delta} day(s) of ${leaveType.name} for ${targetYear} — ${note}`,
  });

  res.json({ empId: String(empId), year: targetYear, type, balance: result.balance });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  }
  const row = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isOwn = req.auth.employeeId && String(row.empId) === String(req.auth.employeeId);
  if (!isHR && !isOwn) {
    const employee = await Employee.findOne({ _id: row.empId, ...companyFilter(req) });
    const isTheirManager = employee?.managerId && String(employee.managerId) === String(req.auth.employeeId);
    if (!isTheirManager) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  }
  res.json(row);
});

// Any authenticated user may file their own leave request; only HR
// Manager/Director can file on behalf of someone else. Self-service requests
// are always created 'pending' — `status` is never taken from the request
// body, so an employee can't submit an already-'approved' request.
router.post('/', validate(fileLeaveSchema), async (req, res) => {
  const isHR = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const { empId, type, start, end, reason, isHalfDay, halfDayTiming, attachment } = req.body || {};

  if (!isHR && String(empId) !== String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file leave for yourself.' } });
  }
  if (!mongoose.Types.ObjectId.isValid(String(empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
  }
  if (end < start) {
    return res.status(400).json({ error: { code: 'INVALID_RANGE', message: 'The end date cannot be before the start date.' } });
  }

  // Name/dept come from the employee record, never from the request body —
  // otherwise a request can carry a different person's name into approvals,
  // notifications and the audit trail.
  const employee = await Employee.findOne({ _id: empId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const leaveType = await getLeaveType(req.auth.company, type);
  if (!leaveType) {
    return res.status(400).json({ error: { code: 'UNKNOWN_LEAVE_TYPE', message: `"${type}" is not a configured leave type for this company.` } });
  }
  if (isHalfDay && !leaveType.allowHalfDay) {
    return res.status(400).json({ error: { code: 'HALF_DAY_NOT_ALLOWED', message: `${leaveType.name} cannot be taken as a half day.` } });
  }

  // Overlap check (pending + approved only — a withdrawn or declined request
  // must not block a re-file).
  const existingOverlap = await Leave.findOne({
    empId,
    company: req.auth.company,
    status: { $in: ['pending', 'approved'] },
    start: { $lte: end },
    end: { $gte: start },
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

  // Working days, now genuinely excluding company holidays. The old code built
  // its holiday set from the raw Holiday.date display strings ("7 Jun, Sun")
  // and compared them against ISO dates, so no holiday ever matched and
  // employees were charged leave for company holidays.
  const holidays = await Holiday.find({ company: req.auth.company });
  const holidaySet = holidayDateSetForRange(holidays, start, end);
  const calcWorkingDays = calculateWorkingDays(start, end, settingsDoc.workWeek || '5-day', holidaySet);
  const workingDays = isHalfDay ? 0.5 : calcWorkingDays;

  if (workingDays <= 0) {
    return res.status(400).json({
      error: { code: 'NO_WORKING_DAYS', message: 'That range contains no working days — it is entirely weekends and/or company holidays.' },
    });
  }
  if (leaveType.maxConsecutiveDays > 0 && workingDays > leaveType.maxConsecutiveDays) {
    return res.status(400).json({
      error: { code: 'EXCEEDS_MAX_CONSECUTIVE', message: `${leaveType.name} allows at most ${leaveType.maxConsecutiveDays} consecutive day(s).` },
    });
  }
  if (leaveType.documentRequiredAfterDays > 0 && workingDays > leaveType.documentRequiredAfterDays && !attachment) {
    return res.status(400).json({
      error: { code: 'DOCUMENT_REQUIRED', message: `${leaveType.name} longer than ${leaveType.documentRequiredAfterDays} day(s) requires a supporting document.` },
    });
  }

  const year = leaveYearOf(start, settingsDoc.leaveYearStartMonth || 1);
  const created = await Leave.create({
    empId,
    name: employee.name,
    dept: employee.dept,
    type, start, end, reason,
    attachment: attachment || '',
    isHalfDay: Boolean(isHalfDay),
    halfDayTiming: isHalfDay ? (halfDayTiming || 'first-half') : '',
    workingDays,
    leaveYear: year,
    company: req.auth.company,
    approvalStages: settingsDoc.approvalWorkflows?.leave?.length ? settingsDoc.approvalWorkflows.leave : DEFAULT_STAGES,
    currentStage: 0,
    status: 'pending',
  });

  // Reserve the days NOW, not at approval — otherwise an employee can file
  // several requests against the same remaining days and have them all
  // approved later. An insufficient balance rolls the request back.
  const reservation = await reserve({
    company: req.auth.company,
    empId, year, type, days: workingDays,
    refId: created._id,
    actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
    note: `${start} to ${end}`,
  });

  if (!reservation.ok) {
    await Leave.findByIdAndDelete(created._id);
    if (reservation.reason === 'INSUFFICIENT_BALANCE') {
      return res.status(409).json({
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Not enough ${leaveType.name} left — ${reservation.available} day(s) available, ${reservation.requested} requested.`,
          available: reservation.available,
          requested: reservation.requested,
        },
      });
    }
    return res.status(400).json({ error: { code: reservation.reason, message: 'Leave could not be reserved against your balance.' } });
  }

  await logAudit(req, { action: 'Leave requested', subject: created.name, after: created });

  // Notify the approver for the first stage: the reporting manager where one
  // is on file, otherwise HR.
  try {
    const channels = resolveChannels(settingsDoc, 'leave');
    const firstStage = stagesFor(created)[0];
    const recipients = [];

    if (firstStage === 'Reporting Manager' && employee.managerId) {
      const managerUser = await User.findOne({ employeeId: employee.managerId, company: req.auth.company });
      if (managerUser) recipients.push(managerUser);
    }
    if (!recipients.length) {
      recipients.push(...await User.find({ role: 'HR Manager', company: req.auth.company }));
    }

    for (const recipient of recipients) {
      await sendNotification({
        recipientId: recipient._id,
        title: 'New Leave Request',
        message: `${created.name} (${created.dept}) has filed a ${created.isHalfDay ? 'half-day ' : ''}${leaveType.name} request from ${created.start} to ${created.end}.`,
        type: 'leave',
        actionUrl: '/leave',
        channels,
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave requested notifications:', err);
  }

  res.status(201).json({ ...created.toJSON(), balanceAfter: reservation.balance?.available ?? null });
});

// Self-service withdrawal. Pending requests can be withdrawn by the owner;
// an already-approved leave can be cancelled by the owner or HR, which also
// returns the days and clears the attendance marking.
router.post('/:id/withdraw', async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  const isOwner = req.auth.employeeId && String(leave.empId) === String(req.auth.employeeId);
  const isHR = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  if (!isOwner && !isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only withdraw your own leave request.' } });
  }
  if (!['pending', 'approved'].includes(leave.status)) {
    return res.status(400).json({ error: { code: 'CANNOT_WITHDRAW', message: 'Only a pending or approved leave request can be withdrawn.' } });
  }

  const wasApproved = leave.status === 'approved';
  const before = leave.toObject();

  // Conditional update so a withdraw racing an approval can't double-release
  // the reserved days.
  const updated = await Leave.findOneAndUpdate(
    { _id: leave._id, status: leave.status, ...companyFilter(req) },
    { status: wasApproved ? 'cancelled' : 'withdrawn' },
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'That request changed while you were withdrawing it — reload and try again.' } });
  }

  await release({
    company: leave.company,
    empId: leave.empId,
    year: leave.leaveYear || leaveYearOf(leave.start),
    type: leave.type,
    days: leave.workingDays,
    refId: leave._id,
    from: wasApproved ? 'used' : 'pending',
    reason: wasApproved ? 'leave-cancelled' : 'leave-withdrawn',
    actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
  });

  if (wasApproved) await unmarkLeaveOnAttendance(leave);

  await logAudit(req, { action: wasApproved ? 'Approved leave cancelled' : 'Leave withdrawn', subject: leave.name, before, after: updated });
  res.json(updated);
});

router.patch('/:id', requireRole('HR Manager'), validate(patchLeaveSchema), async (req, res) => {
  const before = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  // Closed schema (see validations/leaveValidation.js): `status`, `empId`,
  // `company`, `workingDays` and `currentStage` are NOT patchable here. The
  // old handler passed req.body straight into findByIdAndUpdate, so an HR
  // Manager could flip a request to 'approved' directly, skipping every
  // approval stage, the balance deduction and the attendance marking.
  const updated = await Leave.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    req.body,
    { new: true },
  );
  await logAudit(req, { action: 'Leave updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

// Stage-aware approve — see canDecide() above for who may act.
router.post('/:id/approve', validate(decisionSchema), async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }

  const verdict = await canDecide(req, leave);
  if (!verdict.ok) {
    return res.status(403).json({ error: { code: verdict.code, message: verdict.message } });
  }

  const stages = stagesFor(leave);
  const before = leave.toObject();
  const nextStage = leave.currentStage + 1;
  const finalApproval = nextStage >= stages.length;

  // Conditional on the CURRENT stage so two approvers clicking at once can't
  // both advance the request.
  const updated = await Leave.findOneAndUpdate(
    { _id: leave._id, status: 'pending', currentStage: leave.currentStage, ...companyFilter(req) },
    {
      $set: { currentStage: nextStage, ...(finalApproval ? { status: 'approved' } : {}) },
      $push: {
        approvals: {
          role: verdict.actingAs,
          decision: 'approved',
          by: req.auth.name,
          byId: req.auth.id,
          note: req.body?.note || '',
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'This request was decided by someone else — reload to see the current state.' } });
  }

  await logAudit(req, {
    action: `Leave ${updated.status === 'approved' ? 'approved' : 'stage approved'}`,
    subject: updated.name,
    details: `Stage "${verdict.requiredStage}" decided by ${verdict.actingAs}`,
    before,
    after: updated,
  });

  if (updated.status === 'approved') {
    // Convert the reservation made at filing time into a consumption.
    await commit({
      company: updated.company,
      empId: updated.empId,
      year: updated.leaveYear || leaveYearOf(updated.start),
      type: updated.type,
      days: updated.workingDays,
      refId: updated._id,
      actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
    });

    try {
      await markLeaveOnAttendance(updated);
    } catch (err) {
      console.error('Error marking leave on attendance:', err);
    }

    try {
      const recipientUser = await User.findOne({ employeeId: updated.empId, company: updated.company });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: 'Leave Request Approved',
          message: `Your ${updated.type} leave request from ${updated.start} to ${updated.end} has been approved and marked on your attendance.`,
          type: 'leave',
          actionUrl: '/leave',
          channels: resolveChannels(settingsDoc, 'leave'),
          emailOverride: fillTemplate(settingsDoc.notificationTemplates?.email?.leaveApproval, {
            employee: updated.name,
            date: `${updated.start} to ${updated.end}`,
          }),
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending leave approved notification:', err);
    }
  }

  res.json(updated);
});

router.post('/:id/decline', validate(decisionSchema), async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }

  // An employee is entitled to know why, so the reason is recorded whenever
  // it is supplied and the UI now always prompts for one
  // (client/src/context/HRMSContext.jsx declineLeave).
  //
  // It is NOT enforced here: client/src/data/store.js calls
  // `decline: (id) => apiFetch(..., { method: 'POST' })` with no body at all,
  // so a hard requirement made every rejection in the UI fail with an error
  // toast. Enforcing a human-judgement field at the API while the only caller
  // cannot satisfy it breaks the feature instead of improving the record.
  const note = String(req.body?.note || '').trim();

  const verdict = await canDecide(req, leave);
  if (!verdict.ok) {
    return res.status(403).json({ error: { code: verdict.code, message: verdict.message } });
  }

  const before = leave.toObject();
  const updated = await Leave.findOneAndUpdate(
    { _id: leave._id, status: 'pending', currentStage: leave.currentStage, ...companyFilter(req) },
    {
      $set: { status: 'declined', declineReason: note },
      $push: {
        approvals: { role: verdict.actingAs, decision: 'declined', by: req.auth.name, byId: req.auth.id, note, at: new Date() },
      },
    },
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({ error: { code: 'ALREADY_DECIDED', message: 'This request was decided by someone else.' } });
  }

  // Give the reserved days back — a declined request must not keep consuming
  // balance the employee can still use.
  await release({
    company: updated.company,
    empId: updated.empId,
    year: updated.leaveYear || leaveYearOf(updated.start),
    type: updated.type,
    days: updated.workingDays,
    refId: updated._id,
    from: 'pending',
    reason: 'leave-declined',
    actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
    note,
  });

  await logAudit(req, { action: 'Leave declined', subject: updated.name, details: note, before, after: updated });

  try {
    const recipientUser = await User.findOne({ employeeId: updated.empId, company: updated.company });
    if (recipientUser) {
      const settingsDoc = await getSettingsDoc(req.auth.company);
      await sendNotification({
        recipientId: recipientUser._id,
        title: 'Leave Request Declined',
        message: `Your ${updated.type} leave request from ${updated.start} to ${updated.end} was declined. Reason: ${note}`,
        type: 'leave',
        actionUrl: '/leave',
        channels: resolveChannels(settingsDoc, 'leave'),
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave declined notification:', err);
  }

  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Leave.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.json({ id: req.params.id });

  // Deleting a live request must return its reserved days, or they stay
  // locked against the employee's balance with no record to release them.
  if (['pending', 'approved'].includes(before.status)) {
    await release({
      company: before.company,
      empId: before.empId,
      year: before.leaveYear || leaveYearOf(before.start),
      type: before.type,
      days: before.workingDays,
      refId: before._id,
      from: before.status === 'approved' ? 'used' : 'pending',
      reason: 'leave-cancelled',
      actor: { id: req.auth.id, name: req.auth.name, role: req.auth.role },
      note: 'Request deleted by HR',
    });
    if (before.status === 'approved') await unmarkLeaveOnAttendance(before);
  }

  await Leave.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  await logAudit(req, { action: 'Leave deleted', subject: before.name, before });
  res.json({ id: req.params.id });
});

export default router;
