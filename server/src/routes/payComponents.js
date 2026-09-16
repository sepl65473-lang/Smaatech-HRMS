// VARIABLE PAY — overtime, bonus, incentive, arrears, reimbursements and
// ad-hoc deductions for a payroll cycle.
//
// Payroll previously handled a fixed monthly gross, statutory deductions and
// loss of pay, and nothing else. Anything variable had nowhere to live, so it
// was paid outside the system or not at all.
//
// Two rules shape this module:
//   - Nobody approves their own money. A manager may raise overtime for their
//     report; only Finance or HR approves it, and never for themselves.
//   - An overtime AMOUNT is never accepted from a client. Hours are claimed;
//     the rate comes from the employee's own salary and the company's
//     configured multiplier, computed here.
import { Router } from 'express';
import mongoose from 'mongoose';
import PayComponent, { EARNING_KINDS, DEDUCTION_KINDS, PAY_COMPONENT_KINDS } from '../models/PayComponent.js';
import Employee from '../models/Employee.js';
import Payroll from '../models/Payroll.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { employmentPolicy } from './lifecycle.js';

const router = Router();
router.use(requireAuth);

const CYCLE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Who may APPROVE money. Deliberately not the same as who may raise it.
const APPROVER_ROLES = ['Finance Lead', 'HR Director'];
const RAISER_ROLES = ['Finance Lead', 'HR Director', 'HR Manager'];
const VIEW_ALL_ROLES = ['Finance Lead', 'HR Director', 'HR Manager'];

const isApprover = (req) => APPROVER_ROLES.includes(req.auth.role);
const canViewAll = (req) => VIEW_ALL_ROLES.includes(req.auth.role);

/**
 * The ordinary hourly rate for an employee, from their own gross and the
 * company's configured working pattern.
 *
 * Every number here is configuration (Settings.employmentPolicy) or the
 * employee's own record. Nothing is invented, and nothing comes from the
 * request.
 */
export function overtimeValue({ gross, policy, hours }) {
  const monthlyHours = Math.max(1, policy.monthlyWorkingDays * policy.dailyWorkHours);
  const hourlyRate = Math.round(((Number(gross) || 0) / monthlyHours) * 100) / 100;
  const amount = Math.round(hourlyRate * policy.overtimeMultiplier * hours);
  return { hourlyRate, multiplier: policy.overtimeMultiplier, amount };
}

/** A manager may raise something for their own direct report. */
async function isTheirReport(req, empId) {
  if (!req.auth.employeeId) return false;
  const target = await Employee.findOne({ _id: empId, ...companyFilter(req) }, { managerId: 1 }).lean();
  return Boolean(target?.managerId && String(target.managerId) === String(req.auth.employeeId));
}

router.get('/', async (req, res) => {
  const filter = { ...companyFilter(req) };

  if (req.query.cycle) {
    if (!CYCLE_RE.test(String(req.query.cycle))) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'cycle must be YYYY-MM.' } });
    }
    filter.cycle = String(req.query.cycle);
  }
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.kind) filter.kind = String(req.query.kind);

  if (canViewAll(req)) {
    if (req.query.empId) {
      if (!mongoose.Types.ObjectId.isValid(String(req.query.empId))) {
        return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
      }
      filter.empId = req.query.empId;
    }
  } else if (req.auth.employeeId) {
    // Everyone else sees their own, plus anything they raised for a report.
    const reports = await Employee.find(
      { ...companyFilter(req), managerId: req.auth.employeeId }, { _id: 1 },
    ).lean();
    filter.empId = { $in: [req.auth.employeeId, ...reports.map((r) => r._id)] };
  } else {
    return res.json([]);
  }

  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const rows = await PayComponent.find(filter).sort({ cycle: -1, createdAt: -1 }).limit(limit);
  res.json(rows);
});

/**
 * Raises a component. Overtime is claimed in HOURS; everything else in an
 * amount.
 */
router.post('/', async (req, res) => {
  const { empId, cycle, kind, description } = req.body || {};

  if (!PAY_COMPONENT_KINDS.includes(String(kind))) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: `kind must be one of: ${PAY_COMPONENT_KINDS.join(', ')}.` },
    });
  }
  if (!CYCLE_RE.test(String(cycle || ''))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'cycle must be YYYY-MM.' } });
  }
  if (!empId || !mongoose.Types.ObjectId.isValid(String(empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
  }

  const employee = await Employee.findOne({ _id: empId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  // Raising pay for someone is HR/Finance work, except that a manager may
  // claim overtime for their own direct report.
  const allowed = RAISER_ROLES.includes(req.auth.role)
    || (String(kind) === 'overtime' && await isTheirReport(req, empId));
  if (!allowed) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'You cannot raise a pay component for this employee.' },
    });
  }
  // Nobody raises money for themselves.
  if (req.auth.employeeId && String(empId) === String(req.auth.employeeId) && !isApprover(req)) {
    return res.status(403).json({
      error: { code: 'SELF_RAISE_FORBIDDEN', message: 'You cannot raise a pay component for yourself.' },
    });
  }

  // Once a cycle has been disbursed, adding to it would change a payslip
  // someone has already been paid against.
  const existingPayroll = await Payroll.findOne({ company: req.auth.company, empId, cycle });
  if (existingPayroll && existingPayroll.status === 'paid') {
    return res.status(409).json({
      error: {
        code: 'CYCLE_ALREADY_PAID',
        message: `${employee.name}'s payroll for ${cycle} has already been paid. Raise this against the next cycle instead.`,
      },
    });
  }

  const doc = {
    company: req.auth.company,
    empId,
    employeeName: employee.name,
    cycle: String(cycle),
    kind: String(kind),
    description: String(description || '').slice(0, 300),
    raisedBy: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
    dedupeKey: req.body?.dedupeKey ? String(req.body.dedupeKey).slice(0, 200) : null,
  };

  if (String(kind) === 'overtime') {
    const hours = Number(req.body?.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 400) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'hours must be between 0 and 400.' } });
    }
    // The AMOUNT is computed, never accepted — otherwise a claim could name
    // its own value.
    const policy = await employmentPolicy(req.auth.company);
    const valued = overtimeValue({ gross: employee.salary, policy, hours });
    doc.hours = hours;
    doc.hourlyRate = valued.hourlyRate;
    doc.multiplier = valued.multiplier;
    doc.amount = valued.amount;
    doc.status = policy.overtimeRequiresApproval ? 'pending' : 'approved';
    if (doc.status === 'approved') {
      doc.approvedBy = { id: null, name: 'Auto-approved by policy', role: 'System' };
      doc.decidedAt = new Date();
    }
  } else {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e8) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amount must be between 0 and 100,000,000.' } });
    }
    doc.amount = Math.round(amount);
    doc.status = 'pending';
  }

  let created;
  try {
    created = await PayComponent.create(doc);
  } catch (err) {
    if (err.code === 11000) {
      const existing = await PayComponent.findOne({ company: req.auth.company, dedupeKey: doc.dedupeKey });
      return res.status(409).json({
        error: { code: 'DUPLICATE', message: 'That pay component has already been raised.', existingId: existing ? String(existing._id) : null },
      });
    }
    throw err;
  }

  await logAudit(req, {
    action: 'Pay component raised',
    subject: employee.name,
    after: created,
    details: `${created.kind} ${created.amount} for ${created.cycle}`,
  });

  res.status(201).json(created);
});

/** Approve or reject. Never by the person it pays, and never after payout. */
router.post('/:id/decision', requireRole(...APPROVER_ROLES), async (req, res) => {
  const decision = String(req.body?.decision || '');
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: "decision must be 'approved' or 'rejected'." } });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pay component not found.' } });
  }

  const component = await PayComponent.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!component) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pay component not found.' } });

  if (req.auth.employeeId && String(component.empId) === String(req.auth.employeeId)) {
    return res.status(403).json({
      error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot approve a payment to yourself.' },
    });
  }
  if (component.status === 'paid') {
    return res.status(409).json({ error: { code: 'ALREADY_PAID', message: 'This component has already been paid.' } });
  }
  if (decision === 'rejected' && !String(req.body?.note || '').trim()) {
    return res.status(400).json({ error: { code: 'NOTE_REQUIRED', message: 'A reason is required to reject a pay component.' } });
  }

  // Conditional update, so two approvers clicking at once produce one decision.
  const updated = await PayComponent.findOneAndUpdate(
    { _id: component._id, company: req.auth.company, status: { $in: ['pending', 'draft'] } },
    {
      status: decision,
      approvedBy: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
      decidedAt: new Date(),
      decisionNote: String(req.body?.note || '').slice(0, 300),
    },
    { new: true },
  );
  if (!updated) {
    return res.status(409).json({
      error: { code: 'ALREADY_DECIDED', message: `This component is already ${component.status}.` },
    });
  }

  await logAudit(req, {
    action: `Pay component ${decision}`,
    subject: updated.employeeName,
    before: component,
    after: updated,
  });

  res.json(updated);
});

/** Withdraw something raised in error — only while it is still undecided. */
router.delete('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pay component not found.' } });
  }
  const component = await PayComponent.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!component) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pay component not found.' } });

  const raisedByMe = component.raisedBy?.id && String(component.raisedBy.id) === String(req.auth.sub);
  if (!raisedByMe && !RAISER_ROLES.includes(req.auth.role)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot withdraw this pay component.' } });
  }
  if (!['pending', 'draft'].includes(component.status)) {
    return res.status(409).json({
      error: { code: 'ALREADY_DECIDED', message: `This component is ${component.status} and can no longer be withdrawn.` },
    });
  }

  await PayComponent.deleteOne({ _id: component._id });
  await logAudit(req, { action: 'Pay component withdrawn', subject: component.employeeName, before: component });
  res.json({ deleted: true, id: String(component._id) });
});

/** What a cycle would add, so Finance can see it before running payroll. */
router.get('/summary', requireRole(...VIEW_ALL_ROLES, 'managePayroll'), async (req, res) => {
  const cycle = String(req.query.cycle || '');
  if (!CYCLE_RE.test(cycle)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'cycle must be YYYY-MM.' } });
  }

  const rows = await PayComponent.aggregate([
    { $match: { company: req.auth.company, cycle } },
    { $group: { _id: { kind: '$kind', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  const byKind = {};
  let approvedEarnings = 0;
  let approvedDeductions = 0;
  let pendingTotal = 0;

  for (const row of rows) {
    const { kind, status } = row._id;
    byKind[kind] = byKind[kind] || {};
    byKind[kind][status] = { total: row.total, count: row.count };
    if (status === 'approved' || status === 'paid') {
      if (EARNING_KINDS.includes(kind)) approvedEarnings += row.total;
      if (DEDUCTION_KINDS.includes(kind)) approvedDeductions += row.total;
    }
    if (status === 'pending') pendingTotal += row.total;
  }

  res.json({
    cycle,
    byKind,
    approvedEarnings,
    approvedDeductions,
    // Surfaced separately so nobody runs a cycle believing everything raised
    // has been decided.
    pendingTotal,
    pendingCount: rows.filter((r) => r._id.status === 'pending').reduce((sum, r) => sum + r.count, 0),
  });
});

export default router;
