// EMPLOYMENT LIFECYCLE EVENTS.
//
// Confirmation, probation extension, transfer, promotion, salary revision and
// status changes. Before this existed, these happened by editing the employee
// form: the previous department or salary was overwritten and gone, there was
// no effective date, and nothing distinguished a promotion from a typo.
//
// Every route here does the same three things in one place:
//   1. records an immutable LifecycleEvent (who, when, from what, to what, why)
//   2. applies the change to the Employee document
//   3. audits it
//
// Policy numbers (probation length, notice period) come from
// Settings.employmentPolicy — this module never invents them.
import { Router } from 'express';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import LifecycleEvent, { LIFECYCLE_EVENT_TYPES } from '../models/LifecycleEvent.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { runInTransaction } from '../lib/transactionHelper.js';
import { sendNotification, resolveChannels } from '../lib/notificationService.js';
import { getSettingsDoc } from './settings.js';
import Settings from '../models/Settings.js';
import { invalidateCache } from '../lib/cacheStore.js';
import { todayISO } from '../lib/dateUtils.js';

const router = Router();
router.use(requireAuth);

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Changing someone's grade, department or pay is an HR act. Finance can read
// the history (it explains a payroll figure) but cannot create events.
const HR_ROLES = ['HR Director', 'HR Manager'];
const READ_ROLES = [...HR_ROLES, 'Finance Lead'];

/** The company's configured policy, with a flag saying whether HR confirmed it. */
export async function employmentPolicy(company) {
  const settings = await getSettingsDoc(company);
  const policy = settings.employmentPolicy || {};
  return {
    probationMonths: Number(policy.probationMonths ?? 6),
    probationExtensionMonths: Number(policy.probationExtensionMonths ?? 3),
    noticePeriodDays: Number(policy.noticePeriodDays ?? 30),
    noticePeriodDaysOnProbation: Number(policy.noticePeriodDaysOnProbation ?? 15),
    overtimeMultiplier: Number(policy.overtimeMultiplier ?? 2),
    monthlyWorkingDays: Number(policy.monthlyWorkingDays ?? 26),
    dailyWorkHours: Number(policy.dailyWorkHours ?? 8),
    overtimeRequiresApproval: policy.overtimeRequiresApproval !== false,
    confirmedByHR: policy.confirmedByHR === true,
  };
}

export function addMonths(isoDate, months) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const base = new Date(Date.UTC(y, (m - 1) + months, d));
  return base.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + days));
  return base.toISOString().slice(0, 10);
}

/**
 * Records an event and applies its changes to the employee, in one transaction
 * where the deployment supports it — a lifecycle event that exists without its
 * effect (or the reverse) is worse than neither.
 */
async function recordEvent(req, { employee, type, effectiveDate, changes, reason, note, employeeUpdate, dedupeKey }) {
  let event;
  await runInTransaction(async (session) => {
    const opts = session ? { session } : {};
    const [created] = await LifecycleEvent.create([{
      company: req.auth.company,
      empId: employee._id,
      employeeName: employee.name,
      type,
      effectiveDate,
      changes,
      reason: reason || '',
      note: note || '',
      dedupeKey: dedupeKey || null,
      actor: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
    }], opts);
    event = created;

    if (employeeUpdate && Object.keys(employeeUpdate).length) {
      await Employee.updateOne({ _id: employee._id, company: req.auth.company }, employeeUpdate, opts);
    }
  });

  await logAudit(req, {
    action: `Lifecycle: ${type}`,
    subject: employee.name,
    after: event,
    details: Object.entries(changes || {})
      .map(([field, v]) => `${field}: ${v?.from ?? '—'} → ${v?.to ?? '—'}`)
      .join('; '),
  });

  return event;
}

/** Tells the person it happened to. A salary revision nobody mentions is a bug. */
async function notifyEmployee(req, employee, title, message) {
  try {
    const account = await User.findOne({ employeeId: employee._id, company: req.auth.company });
    if (!account) return;
    const settings = await getSettingsDoc(req.auth.company);
    await sendNotification({
      recipientId: account._id,
      title,
      message,
      type: 'system',
      actionUrl: `/employees/${employee._id}`,
      channels: resolveChannels(settings, 'leave'),
      company: req.auth.company,
    });
  } catch {
    // A notification failure must never roll back an employment change that
    // has already been recorded; delivery has its own retry.
  }
}

async function loadEmployee(req, id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return Employee.findOne({ _id: id, ...companyFilter(req) });
}

function effectiveDateFrom(body) {
  const given = String(body?.effectiveDate || '');
  return ISO_DATE.test(given) ? given : todayISO();
}

// ─────────────────────────── policy ───────────────────────────

/**
 * The configured employment policy. Readable by any signed-in user — an
 * employee is entitled to know their own notice period — but only HR writes it.
 */
router.get('/policy', async (req, res) => {
  const policy = await employmentPolicy(req.auth.company);
  res.json({
    ...policy,
    // Never let an unreviewed default pass for an agreed company policy.
    note: policy.confirmedByHR
      ? 'Confirmed by HR.'
      : 'These are starting defaults. They have not been confirmed by HR for this company yet.',
  });
});

router.put('/policy', requireRole('HR Director'), async (req, res) => {
  const numbers = {
    probationMonths: [0, 36],
    probationExtensionMonths: [0, 24],
    noticePeriodDays: [0, 365],
    noticePeriodDaysOnProbation: [0, 365],
    overtimeMultiplier: [1, 5],
    monthlyWorkingDays: [1, 31],
    dailyWorkHours: [1, 24],
  };

  const patch = {};
  for (const [field, [min, max]] of Object.entries(numbers)) {
    if (req.body?.[field] === undefined) continue;
    const value = Number(req.body[field]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `${field} must be a number between ${min} and ${max}.` },
      });
    }
    patch[field] = value;
  }
  if (req.body?.overtimeRequiresApproval !== undefined) {
    patch.overtimeRequiresApproval = Boolean(req.body.overtimeRequiresApproval);
  }
  // Setting the policy IS the act of confirming it.
  patch.confirmedByHR = true;

  const current = await employmentPolicy(req.auth.company);
  const merged = { ...current, ...patch };
  await Settings.findByIdAndUpdate(
    req.auth.company,
    { $set: { employmentPolicy: merged } },
    { upsert: true },
  );
  // getSettingsDoc caches for five minutes; without this the company would set
  // a policy, see it accepted, and watch the old numbers keep being applied.
  invalidateCache(`settings:${req.auth.company}`);

  await logAudit(req, {
    action: 'Employment policy updated',
    subject: req.auth.company,
    before: current,
    after: merged,
  });

  res.json({ ...merged, note: 'Confirmed by HR.' });
});

// ─────────────────────────── history ───────────────────────────

/** An employee may read their OWN history; HR and Finance read anyone's. */
router.get('/events', async (req, res) => {
  const isPrivileged = READ_ROLES.includes(req.auth.role);
  const filter = { ...companyFilter(req) };

  if (req.query.empId) {
    if (!mongoose.Types.ObjectId.isValid(String(req.query.empId))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
    }
    if (!isPrivileged && String(req.query.empId) !== String(req.auth.employeeId)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view your own employment history.' } });
    }
    filter.empId = req.query.empId;
  } else if (!isPrivileged) {
    if (!req.auth.employeeId) return res.json([]);
    filter.empId = req.auth.employeeId;
  }

  if (req.query.type) {
    if (!LIFECYCLE_EVENT_TYPES.includes(String(req.query.type))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown event type.' } });
    }
    filter.type = String(req.query.type);
  }

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await LifecycleEvent.find(filter).sort({ effectiveDate: -1, createdAt: -1 }).limit(limit);
  res.json(rows);
});

/**
 * Who is due for a confirmation decision.
 *
 * This is the whole point of tracking probation: without a queue, confirmation
 * is remembered or it is not, and people sit on probation for months past
 * their date.
 */
router.get('/probation/due', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const policy = await employmentPolicy(req.auth.company);
  const horizonDays = Math.min(180, Math.max(0, parseInt(req.query.withinDays, 10) || 30));
  const cutoff = addDays(todayISO(), horizonDays);

  const rows = await Employee.find({
    ...companyFilter(req),
    employmentStage: 'Probation',
    status: { $ne: 'exited' },
    probationEndDate: { $ne: '', $lte: cutoff },
  }).sort({ probationEndDate: 1 }).limit(200);

  res.json({
    asOf: todayISO(),
    withinDays: horizonDays,
    policy: { probationMonths: policy.probationMonths, confirmedByHR: policy.confirmedByHR },
    due: rows.map((e) => ({
      id: String(e._id),
      name: e.name,
      dept: e.dept,
      role: e.role,
      joinDate: e.joinDate,
      probationEndDate: e.probationEndDate,
      overdue: e.probationEndDate < todayISO(),
    })),
  });
});

// ─────────────────────────── events ───────────────────────────

/**
 * Starts (or restates) probation — used at hire, and available to HR when an
 * employee record predates this module and has no probation dates at all.
 */
router.post('/:id/probation/start', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage === 'Exited') {
    return res.status(409).json({ error: { code: 'EMPLOYEE_EXITED', message: 'This employee has left the company.' } });
  }

  const policy = await employmentPolicy(req.auth.company);
  const startFrom = ISO_DATE.test(String(req.body?.startFrom || '')) ? String(req.body.startFrom)
    : (ISO_DATE.test(String(employee.joinDate || '')) ? employee.joinDate : todayISO());
  const probationEndDate = addMonths(startFrom, policy.probationMonths);

  const event = await recordEvent(req, {
    employee,
    type: 'probation-started',
    effectiveDate: startFrom,
    changes: {
      employmentStage: { from: employee.employmentStage, to: 'Probation' },
      probationEndDate: { from: employee.probationEndDate || null, to: probationEndDate },
    },
    reason: req.body?.reason,
    note: `${policy.probationMonths}-month probation per company policy`,
    employeeUpdate: { employmentStage: 'Probation', probationEndDate, confirmationDate: '' },
  });

  res.status(201).json({ event, probationEndDate, policyConfirmedByHR: policy.confirmedByHR });
});

router.post('/:id/probation/extend', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage !== 'Probation') {
    return res.status(409).json({
      error: { code: 'NOT_ON_PROBATION', message: `${employee.name} is not on probation (currently ${employee.employmentStage || 'Probation'}).` },
    });
  }
  // Extending someone's probation is a decision against them; it must carry a
  // reason that can be shown to them later.
  if (!String(req.body?.reason || '').trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required to extend probation.' } });
  }

  const policy = await employmentPolicy(req.auth.company);
  const months = req.body?.months !== undefined ? Number(req.body.months) : policy.probationExtensionMonths;
  if (!Number.isFinite(months) || months <= 0 || months > 24) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'months must be between 1 and 24.' } });
  }

  const from = employee.probationEndDate || employee.joinDate || todayISO();
  const probationEndDate = addMonths(from, months);

  const event = await recordEvent(req, {
    employee,
    type: 'probation-extended',
    effectiveDate: effectiveDateFrom(req.body),
    changes: { probationEndDate: { from: employee.probationEndDate || null, to: probationEndDate } },
    reason: req.body.reason,
    note: req.body?.note,
    employeeUpdate: { probationEndDate },
  });

  await notifyEmployee(req, employee, 'Probation extended',
    `Your probation has been extended to ${probationEndDate}.`);

  res.status(201).json({ event, probationEndDate });
});

router.post('/:id/confirm', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage === 'Confirmed') {
    return res.status(409).json({
      error: { code: 'ALREADY_CONFIRMED', message: `${employee.name} was already confirmed on ${employee.confirmationDate || 'an earlier date'}.` },
    });
  }
  if (employee.employmentStage === 'Exited') {
    return res.status(409).json({ error: { code: 'EMPLOYEE_EXITED', message: 'This employee has left the company.' } });
  }

  const effectiveDate = effectiveDateFrom(req.body);

  const event = await recordEvent(req, {
    employee,
    type: 'confirmed',
    effectiveDate,
    changes: {
      employmentStage: { from: employee.employmentStage, to: 'Confirmed' },
      confirmationDate: { from: employee.confirmationDate || null, to: effectiveDate },
    },
    reason: req.body?.reason,
    note: req.body?.note,
    // One confirmation per employee, whatever a double-click does.
    dedupeKey: `confirm:${employee._id}`,
    employeeUpdate: { employmentStage: 'Confirmed', confirmationDate: effectiveDate },
  });

  await notifyEmployee(req, employee, 'Employment confirmed',
    `Your employment has been confirmed with effect from ${effectiveDate}.`);

  res.status(201).json({ event, confirmationDate: effectiveDate });
});

router.post('/:id/transfer', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage === 'Exited') {
    return res.status(409).json({ error: { code: 'EMPLOYEE_EXITED', message: 'This employee has left the company.' } });
  }

  const changes = {};
  const update = {};
  for (const field of ['dept', 'loc']) {
    const value = req.body?.[field];
    if (value === undefined || String(value) === String(employee[field] || '')) continue;
    if (!String(value).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `${field} cannot be blank.` } });
    }
    changes[field] = { from: employee[field] || null, to: String(value) };
    update[field] = String(value);
  }

  if (req.body?.managerId !== undefined) {
    const nextManager = req.body.managerId ? String(req.body.managerId) : null;
    if (nextManager) {
      if (!mongoose.Types.ObjectId.isValid(nextManager)) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'managerId is not a valid id.' } });
      }
      if (nextManager === String(employee._id)) {
        return res.status(400).json({ error: { code: 'SELF_MANAGED', message: 'An employee cannot report to themselves.' } });
      }
      const manager = await Employee.findOne({ _id: nextManager, ...companyFilter(req) });
      if (!manager) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The new reporting manager was not found.' } });
      // A reporting cycle would make the org chart and every manager-scoped
      // query recurse for ever.
      if (await createsReportingCycle(req.auth.company, employee._id, nextManager)) {
        return res.status(409).json({
          error: { code: 'REPORTING_CYCLE', message: 'That reporting line would create a cycle.' },
        });
      }
    }
    if (String(employee.managerId || '') !== String(nextManager || '')) {
      changes.managerId = { from: employee.managerId ? String(employee.managerId) : null, to: nextManager };
      update.managerId = nextManager;
    }
  }

  if (!Object.keys(changes).length) {
    return res.status(400).json({ error: { code: 'NO_CHANGE', message: 'A transfer needs at least one change: department, location or reporting manager.' } });
  }

  const event = await recordEvent(req, {
    employee,
    type: 'transferred',
    effectiveDate: effectiveDateFrom(req.body),
    changes,
    reason: req.body?.reason,
    note: req.body?.note,
    employeeUpdate: update,
  });

  await notifyEmployee(req, employee, 'Transfer recorded',
    `Your ${Object.keys(changes).join(', ')} has been updated with effect from ${event.effectiveDate}.`);

  res.status(201).json({ event });
});

/** Walks up the proposed chain looking for the employee being moved. */
async function createsReportingCycle(company, empId, proposedManagerId) {
  let cursor = proposedManagerId;
  for (let hops = 0; hops < 50 && cursor; hops += 1) {
    if (String(cursor) === String(empId)) return true;
    // eslint-disable-next-line no-await-in-loop
    const next = await Employee.findOne({ _id: cursor, company }, { managerId: 1 }).lean();
    cursor = next?.managerId || null;
  }
  return false;
}

router.post('/:id/promote', requireRole(...HR_ROLES, 'manageEmployees'), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage === 'Exited') {
    return res.status(409).json({ error: { code: 'EMPLOYEE_EXITED', message: 'This employee has left the company.' } });
  }

  const newRole = String(req.body?.role || '').trim();
  if (!newRole) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The new designation is required.' } });
  }
  if (newRole === employee.role) {
    return res.status(400).json({ error: { code: 'NO_CHANGE', message: `${employee.name} is already a ${newRole}.` } });
  }

  const changes = { role: { from: employee.role || null, to: newRole } };
  const update = { role: newRole };

  // A promotion usually carries a raise, and recording them as one event keeps
  // the two from drifting apart in the history.
  if (req.body?.salary !== undefined) {
    const salary = Number(req.body.salary);
    if (!Number.isFinite(salary) || salary < 0 || salary > 1e9) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'salary must be a number between 0 and 1,000,000,000.' } });
    }
    changes.salary = { from: employee.salary ?? null, to: salary };
    update.salary = salary;
    if (req.body?.basic !== undefined) {
      const basic = Number(req.body.basic);
      if (!Number.isFinite(basic) || basic < 0 || basic > salary) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'basic must be between 0 and the new gross.' } });
      }
      changes.basic = { from: employee.basic ?? null, to: basic };
      update.basic = basic;
    }
  }

  const event = await recordEvent(req, {
    employee,
    type: 'promoted',
    effectiveDate: effectiveDateFrom(req.body),
    changes,
    reason: req.body?.reason,
    note: req.body?.note,
    employeeUpdate: update,
  });

  await notifyEmployee(req, employee, 'Promotion recorded',
    `You have been promoted to ${newRole} with effect from ${event.effectiveDate}.`);

  res.status(201).json({ event });
});

router.post('/:id/salary-revision', requireRole(...HR_ROLES), async (req, res) => {
  const employee = await loadEmployee(req, req.params.id);
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  if (employee.employmentStage === 'Exited') {
    return res.status(409).json({ error: { code: 'EMPLOYEE_EXITED', message: 'This employee has left the company.' } });
  }

  const salary = Number(req.body?.salary);
  if (!Number.isFinite(salary) || salary < 0 || salary > 1e9) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'salary must be a number between 0 and 1,000,000,000.' } });
  }
  if (salary === employee.salary) {
    return res.status(400).json({ error: { code: 'NO_CHANGE', message: 'That is the current salary.' } });
  }
  // A pay CUT is legitimate but must never be a slip of the keyboard.
  if (salary < (employee.salary || 0) && !String(req.body?.reason || '').trim()) {
    return res.status(400).json({
      error: { code: 'REASON_REQUIRED', message: 'A reduction in salary requires a reason.' },
    });
  }

  const changes = { salary: { from: employee.salary ?? null, to: salary } };
  const update = { salary };

  for (const field of ['basic', 'da', 'hra']) {
    if (req.body?.[field] === undefined) continue;
    const value = Number(req.body[field]);
    if (!Number.isFinite(value) || value < 0 || value > salary) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `${field} must be between 0 and the new gross.` } });
    }
    changes[field] = { from: employee[field] ?? null, to: value };
    update[field] = value;
  }

  const event = await recordEvent(req, {
    employee,
    type: 'salary-revised',
    effectiveDate: effectiveDateFrom(req.body),
    changes,
    reason: req.body?.reason,
    note: req.body?.note,
    employeeUpdate: update,
  });

  await notifyEmployee(req, employee, 'Salary revised',
    `Your salary has been revised with effect from ${event.effectiveDate}. See your profile for details.`);

  res.status(201).json({ event });
});

export default router;
