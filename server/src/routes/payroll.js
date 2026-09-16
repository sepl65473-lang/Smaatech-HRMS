import { Router } from 'express';
import mongoose from 'mongoose';
import Payroll from '../models/Payroll.js';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createPayrollSchema, patchPayrollSchema, runPayrollSchema } from '../validations/payrollValidation.js';

import { logAudit } from '../lib/auditLogger.js';
import User from '../models/User.js';
import { sendNotification, resolveChannels, fillTemplate } from '../lib/notificationService.js';
import { getSettingsDoc } from './settings.js';
import { computeStatutoryDeductions } from '../lib/statutory.js';
import PayComponent, { EARNING_KINDS, DEDUCTION_KINDS } from '../models/PayComponent.js';

const router = Router();
router.use(requireAuth);

// Roles allowed to see every employee's payroll, not just their own.
const PAYROLL_VIEW_ALL = ['HR Director', 'HR Manager', 'Finance Lead'];

// Derives Loss-of-Pay days from actual attendance for the cycle (a full
// 'absent' day counts as 1, a 'half-day' as 0.5) — same 30-day-basis formula
// SalaryStructureModal.jsx already uses client-side for manual entry, so
// auto-computed and hand-entered LOP amounts stay consistent.
async function computeLopFromAttendance(empId, cycle, company, gross) {
  const rows = await Attendance.find({ empId, company, date: { $regex: `^${cycle}` } });
  let lopDays = 0;
  for (const row of rows) {
    if (row.status === 'absent') lopDays += 1;
    else if (row.status === 'half-day') lopDays += 0.5;
  }
  const lopAmount = Math.round((Number(gross) || 0) / 30 * lopDays);
  return { lopDays, lopAmount };
}

// Builds the statutory (PF/ESI/PT/TDS) deduction lines for an employee's
// cycle from their own on-file salary structure and statutory identity.
// Returns null when the employee record can't be found, so the caller keeps
// whatever the operator entered by hand rather than substituting zeros.
async function buildStatutory(empId, cycle, company, gross) {
  if (!mongoose.Types.ObjectId.isValid(String(empId))) return null;
  const emp = await Employee.findOne({ _id: empId, company });
  if (!emp) return null;
  const month = Number(String(cycle || '').split('-')[1]) || null;
  return computeStatutoryDeductions({
    gross,
    basic: emp.basic ?? null,
    da: emp.da ?? 0,
    state: emp.state || null,
    gender: emp.gender || null,
    month,
    pan: emp.pan || '',
    uan: emp.uan || '',
    esiNumber: emp.esiNumber || '',
    taxRegime: emp.taxRegime || 'new',
  });
}


/**
 * Approved variable pay for one employee and cycle: overtime, bonus,
 * incentives, arrears, reimbursements, and ad-hoc deductions.
 *
 * Only 'approved' components are taken. Anything still pending is deliberately
 * left out rather than paid optimistically — and the run reports how many were
 * skipped, so nobody assumes silence means there was nothing there.
 */
async function variablePayFor(empId, cycle, company) {
  const components = await PayComponent.find({
    company, empId, cycle, status: 'approved',
  }).sort({ kind: 1, createdAt: 1 });

  const earnings = [];
  const deductions = [];
  let earningsTotal = 0;
  let deductionsTotal = 0;

  for (const component of components) {
    const label = component.kind === 'overtime'
      // The payslip line explains itself: 6h at 2x of the ordinary rate.
      ? `Overtime (${component.hours}h @ ${component.multiplier}x)`
      : component.description || component.kind.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

    if (EARNING_KINDS.includes(component.kind)) {
      earnings.push({ name: label, amount: component.amount });
      earningsTotal += component.amount;
    } else if (DEDUCTION_KINDS.includes(component.kind)) {
      deductions.push({ name: label, amount: component.amount, category: 'Other' });
      deductionsTotal += component.amount;
    }
  }

  return { components, earnings, deductions, earningsTotal, deductionsTotal };
}

router.get('/', async (req, res) => {
  const canSeeAll = PAYROLL_VIEW_ALL.includes(req.auth.role);
  // An account with no linked employee profile has no payroll of its own —
  // scoping on `undefined` would otherwise match every row with no empId.
  if (!canSeeAll && !req.auth.employeeId) return res.json([]);
  const scope = { ...companyFilter(req), ...(canSeeAll ? {} : { empId: req.auth.employeeId }) };
  const { page, limit, cycle, status } = req.query;

  const filter = { ...scope };
  if (cycle) filter.cycle = cycle;
  if (status) filter.status = status;

  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const rows = await Payroll.find(filter).sort({ createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(rows);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Payroll.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Payroll.countDocuments(filter),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
});

// Statutory preview — lets Finance see the PF/ESI/PT/TDS breakdown (and every
// warning about what could NOT be computed) before committing a payroll row.
router.get('/statutory/preview', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const { empId, cycle, gross } = req.query;
  if (!empId || !cycle) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId and cycle are required.' } });
  }
  if (!mongoose.Types.ObjectId.isValid(String(empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
  }
  const emp = await Employee.findOne({ _id: empId, ...companyFilter(req) });
  if (!emp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const grossAmt = gross != null ? Number(gross) : Number(emp.salary) || 0;
  const statutory = await buildStatutory(empId, cycle, req.auth.company, grossAmt);
  res.json({ empId: String(empId), cycle, gross: grossAmt, ...statutory });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  }
  const canSeeAll = PAYROLL_VIEW_ALL.includes(req.auth.role);
  if (!canSeeAll && !req.auth.employeeId) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  }
  const scope = { _id: req.params.id, ...companyFilter(req), ...(canSeeAll ? {} : { empId: req.auth.employeeId }) };
  const row = await Payroll.findOne(scope);
  // Previously returned 200 with a `null` body for a row that doesn't exist or
  // the caller may not see — indistinguishable from an empty record.
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  res.json(row);
});

// HR Manager needs this too — addEmployee/updateEmployee/deleteEmployee (all
// gated to HR Manager on /employees) cascade payroll row create/patch/delete
// for denormalization sync, alongside Finance Lead's own process/pay actions.
router.post('/', requireRole('HR Manager', 'Finance Lead'), validate(createPayrollSchema), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || null;

  if (!mongoose.Types.ObjectId.isValid(String(body.empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
  }
  // Cross-tenant guard: the employee must belong to the caller's company.
  if (!(await Employee.exists({ _id: body.empId, company: req.auth.company }))) {
    return res.status(404).json({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found in this company.' } });
  }

  // Only auto-compute when the caller didn't explicitly send a value —
  // manual entry (SalaryStructureModal) always wins.
  if (body.lopDays === undefined && body.empId && body.cycle) {
    const { lopDays, lopAmount } = await computeLopFromAttendance(body.empId, body.cycle, req.auth.company, body.gross);
    body.lopDays = lopDays;
    body.lopAmount = lopAmount;
  }

  // Statutory deductions are computed server-side from the employee's own
  // record unless the caller supplied an explicit components breakdown.
  let statutoryWarnings = [];
  if (!body.components && body.gross) {
    const statutory = await buildStatutory(body.empId, body.cycle, req.auth.company, body.gross);
    if (statutory) {
      statutoryWarnings = statutory.warnings;
      body.components = {
        earnings: [{ name: 'Gross Earnings', amount: Number(body.gross) || 0 }],
        deductions: statutory.deductions,
      };
      if (body.deductions === undefined) {
        body.deductions = statutory.employeeTotal + (Number(body.lopAmount) || 0);
      }
      if (body.net === undefined) {
        body.net = Math.max(0, (Number(body.gross) || 0) - Number(body.deductions));
      }
    }
  }

  if (idempotencyKey) body.idempotencyKey = String(idempotencyKey).slice(0, 200);

  let created;
  try {
    created = await Payroll.create(body);
  } catch (err) {
    if (err.code === 11000) {
      // The unique (company, empId, cycle) index did its job. A retry of the
      // SAME logical request (matching Idempotency-Key) gets the existing row
      // back as a success; a genuinely different second run is a 409.
      const existing = await Payroll.findOne({ company: req.auth.company, empId: body.empId, cycle: body.cycle });
      if (existing && idempotencyKey && existing.idempotencyKey === String(idempotencyKey).slice(0, 200)) {
        res.setHeader('X-Idempotent-Replay', 'true');
        return res.status(200).json(existing);
      }
      return res.status(409).json({
        error: {
          code: 'PAYROLL_ALREADY_EXISTS',
          message: `Payroll for this employee already exists for cycle ${body.cycle}. Edit the existing record instead of creating a second one.`,
          existingId: existing ? String(existing._id) : null,
        },
      });
    }
    throw err;
  }

  await logAudit(req, {
    action: 'Payroll processed',
    subject: created.name,
    after: created,
    details: statutoryWarnings.length ? `statutory warnings: ${statutoryWarnings.join(', ')}` : '',
  });

  // Notify target employee
  if (created.status === 'ready') {
    try {
      const recipientUser = await User.findOne({ employeeId: created.empId, company: req.auth.company });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: 'Payslip Ready',
          message: `Your payslip for cycle ${created.cycle} has been processed and is ready.`,
          type: 'payroll',
          actionUrl: '/payroll',
          // One payslip notice per employee per cycle. Re-running a cycle or
          // retrying a request must not tell the same person their payslip is
          // ready three times.
          dedupeKey: `payslip:ready:${created.cycle}:${created.empId}`,
          channels: resolveChannels(settingsDoc, 'payroll'),
          emailOverride: fillTemplate(settingsDoc.notificationTemplates?.email?.payrollSlip, {
            employee: created.name,
            date: created.cycle,
          }),
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending payroll processed notification:', err);
    }
  }

  res.status(201).json({ ...created.toJSON(), statutoryWarnings });
});

/**
 * Runs payroll for an entire cycle.
 *
 * Until this existed there was NO way to run payroll in the product: a payslip
 * row only appeared as a side effect of creating an employee, so anyone hired
 * before a cycle simply had no payslip for it and the register was silently
 * incomplete. Finance had to create rows one employee at a time.
 *
 * Properties that matter here:
 *  - IDEMPOTENT. Re-running a cycle never duplicates or overwrites. The unique
 *    (company, empId, cycle) index is the backstop, and a duplicate is
 *    reported as skipped rather than failing the run.
 *  - NEVER overwrites a row Finance has already touched, paid or corrected.
 *  - Every figure is derived server-side from the employee's own record; the
 *    request carries nothing but the cycle.
 *  - Employees it could NOT pay are returned by name, because a register that
 *    quietly omits people is worse than one that refuses.
 */
router.post('/run', requireRole('HR Manager', 'Finance Lead'), validate(runPayrollSchema), async (req, res) => {
  const { cycle } = req.body;
  const company = req.auth.company;

  const employees = await Employee.find({ company }).sort({ name: 1 });
  const existing = await Payroll.find({ company, cycle }, { empId: 1 });
  const alreadyRun = new Set(existing.map((p) => String(p.empId)));

  const created = [];
  const skipped = [];
  const unpayable = [];
  let variablePaid = 0;

  for (const emp of employees) {
    if (alreadyRun.has(String(emp._id))) {
      skipped.push({ empId: String(emp._id), name: emp.name, reason: 'ALREADY_IN_REGISTER' });
      continue;
    }
    // An employee with no salary on file cannot be paid a derived amount —
    // guessing one would put a wrong number into a bank advice file.
    const gross = Number(emp.salary) || 0;
    if (gross <= 0) {
      unpayable.push({ empId: String(emp._id), name: emp.name, reason: 'NO_SALARY_ON_FILE' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { lopDays, lopAmount } = await computeLopFromAttendance(emp._id, cycle, company, gross);
    // eslint-disable-next-line no-await-in-loop
    const statutory = await buildStatutory(emp._id, cycle, company, gross);
    // eslint-disable-next-line no-await-in-loop
    const variable = await variablePayFor(emp._id, cycle, company);

    // Statutory deductions are computed on the contractual gross, not on the
    // gross inflated by one-off variable pay — treating a bonus as if it had
    // raised the monthly salary would misstate PF and ESI.
    const payableGross = gross + variable.earningsTotal;
    const deductions = (statutory ? statutory.employeeTotal : 0) + lopAmount + variable.deductionsTotal;

    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await Payroll.create({
        company,
        empId: emp._id,
        name: emp.name,
        dept: emp.dept,
        cycle,
        gross: payableGross,
        lopDays,
        lopAmount,
        deductions,
        net: Math.max(0, payableGross - deductions),
        status: 'ready',
        components: {
          earnings: [{ name: 'Gross Earnings', amount: gross }, ...variable.earnings],
          deductions: [...(statutory ? statutory.deductions : []), ...variable.deductions],
        },
      });
      created.push(row);
      variablePaid += variable.earningsTotal;

      // Bind each component to the payslip that carries it, so it can never be
      // counted into a second one.
      if (variable.components.length) {
        // eslint-disable-next-line no-await-in-loop
        await PayComponent.updateMany(
          { _id: { $in: variable.components.map((c) => c._id) } },
          { payrollId: row._id },
        );
      }
    } catch (err) {
      // A concurrent run (two Finance users clicking at once, or a retried
      // request) loses the race on the unique index. That is the index doing
      // its job, not a failure of this run.
      if (err.code === 11000) {
        skipped.push({ empId: String(emp._id), name: emp.name, reason: 'ALREADY_IN_REGISTER' });
        // eslint-disable-next-line no-continue
        continue;
      }
      throw err;
    }
  }

  // Anything still awaiting approval was NOT paid. Reporting it is the
  // difference between "there was no overtime" and "the overtime nobody
  // approved in time was silently dropped".
  const pendingComponents = await PayComponent.countDocuments({ company, cycle, status: 'pending' });

  await logAudit(req, {
    action: 'Payroll run',
    subject: cycle,
    details: `${created.length} created, ${skipped.length} already present, ${unpayable.length} without salary on file, ${variablePaid} variable pay included, ${pendingComponents} component(s) left unapproved`,
  });

  res.status(created.length ? 201 : 200).json({
    cycle,
    created: created.length,
    skipped: skipped.length,
    skippedRows: skipped,
    unpayable,
    variablePayIncluded: variablePaid,
    pendingComponentsNotPaid: pendingComponents,
    rows: created,
  });
});

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), validate(patchPayrollSchema), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  }
  const before = await Payroll.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });

  // Locking: a paid payslip is a financial record. Editing the amounts on one
  // after disbursement silently rewrites history, so only HR Director may, and
  // only by explicitly unlocking first.
  if (before.lockedAt && req.auth.role !== 'HR Director') {
    return res.status(409).json({
      error: { code: 'PAYROLL_LOCKED', message: 'This payslip is locked because it has been paid. Ask an HR Director to unlock it before editing.' },
    });
  }

  // `validate` has already stripped everything outside patchPayrollSchema, so
  // company/empId/idempotencyKey can no longer be moved by a request body —
  // the old handler passed req.body straight into findByIdAndUpdate.
  const patch = { ...req.body };
  const markingPaid = before.status !== 'paid' && patch.status === 'paid';
  if (markingPaid) {
    patch.lockedAt = new Date();
    patch.lockedBy = req.auth.name || req.auth.role;
  }

  const updated = await Payroll.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    patch,
    { new: true },
  );

  const isProcessed = before.status !== 'ready' && updated.status === 'ready';
  const isPaid = markingPaid;

  // Disbursing the payslip closes out the variable pay it carried, so an
  // approved component can never be picked up again by a later cycle.
  if (isPaid) {
    await PayComponent.updateMany(
      { company: req.auth.company, payrollId: updated._id, status: 'approved' },
      { status: 'paid' },
    );
  }

  if (isProcessed || isPaid) {
    try {
      const recipientUser = await User.findOne({ employeeId: updated.empId, company: req.auth.company });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: isPaid ? 'Salary Disbursed' : 'Payslip Ready',
          message: isPaid
            ? `Your salary for cycle ${updated.cycle} has been disbursed.`
            : `Your payslip for cycle ${updated.cycle} has been processed and is ready.`,
          type: 'payroll',
          actionUrl: '/payroll',
          // One notice per employee per cycle PER EVENT: "ready" and
          // "disbursed" are different things to be told, but neither should
          // arrive twice because a row was edited again.
          dedupeKey: `payslip:${isPaid ? 'paid' : 'ready'}:${updated.cycle}:${updated.empId}`,
          channels: resolveChannels(settingsDoc, 'payroll'),
          emailOverride: isProcessed
            ? fillTemplate(settingsDoc.notificationTemplates?.email?.payrollSlip, {
                employee: updated.name,
                date: updated.cycle,
              })
            : null,
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending payroll patch notification:', err);
    }
  }

  const actionName = isPaid ? 'Payslip marked paid' : 'Salary structure updated';
  await logAudit(req, { action: actionName, subject: updated.name, before, after: updated });
  res.json(updated);
});

// Explicit unlock, HR Director only — the deliberate, audited step that has to
// happen before a disbursed payslip can be corrected.
router.post('/:id/unlock', requireRole('HR Director'), async (req, res) => {
  if (req.auth.role !== 'HR Director') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only an HR Director can unlock a paid payslip.' } });
  }
  const row = await Payroll.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  if (!row.lockedAt) return res.status(400).json({ error: { code: 'NOT_LOCKED', message: 'This payslip is not locked.' } });

  const before = row.toObject();
  row.lockedAt = null;
  row.lockedBy = null;
  await row.save();
  await logAudit(req, {
    action: 'Payslip unlocked for correction',
    subject: row.name,
    details: req.body?.reason || 'no reason given',
    before,
    after: row,
  });
  res.json(row);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  }
  const before = await Payroll.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.json({ id: req.params.id });

  if (before.lockedAt && req.auth.role !== 'HR Director') {
    return res.status(409).json({
      error: { code: 'PAYROLL_LOCKED', message: 'A paid payslip cannot be deleted. Ask an HR Director to unlock it first.' },
    });
  }

  await Payroll.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  await logAudit(req, { action: 'Payroll record removed', subject: before.name, before });
  res.json({ id: req.params.id });
});

export default router;
