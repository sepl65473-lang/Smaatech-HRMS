import { Router } from 'express';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createEmployeeSchema, patchEmployeeSchema } from '../validations/employeeValidation.js';
import { logAudit } from '../lib/auditLogger.js';
import LifecycleEvent from '../models/LifecycleEvent.js';
import { employmentPolicy, addMonths } from './lifecycle.js';
import { todayISO } from '../lib/dateUtils.js';
import { terminateAllAccess } from '../lib/sessionRevoker.js';

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const router = Router();
router.use(requireAuth);

// Fields no ordinary colleague has any business reading about another person.
// GET /employees and GET /employees/:id had NO role gate at all, so every
// authenticated account — including a plain Employee — could pull the whole
// roster complete with each person's salary, bank account number, IFSC, PAN,
// UAN, ESI number, date of birth, personal email, home phone, emergency
// contacts and family details. That is both a salary-confidentiality breach
// and a bulk PII disclosure.
const SENSITIVE_EMPLOYEE_FIELDS = [
  'salary', 'basic', 'da', 'hra',
  'bankAccount', 'ifsc', 'bankName',
  'pan', 'uan', 'esiNumber', 'taxRegime',
  'dob', 'personalEmail', 'phone', 'bloodGroup', 'gender',
  'emergencyContact', 'family', 'rating',
];

// HR/Finance see everything; everyone else sees the directory view of other
// people, plus their own complete record.
function canSeeFullProfiles(req) {
  return ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
}

// Compensation and statutory identity — the subset a REPORTING MANAGER does
// not see about a direct report.
//
// `managerId` is an ORGANISATIONAL RELATIONSHIP, not a role. It legitimately
// carries line-management authority (see a report's leave, approve it, set
// their working status), and this system grants exactly that.
//
// It does NOT carry pay visibility. Enterprise manager-self-service practice
// is that compensation is exposed to a line manager inside a specific workflow
// — a merit-increase or promotion cycle, within HR-set guardrails — rather
// than being always-on directory data; several organisations restrict it to
// director level or above entirely. There is no such compensation workflow in
// this product, so there is no basis for always-on access, and an earlier
// revision of this file granting it was a decision made without evidence.
//
// BUSINESS DECISION REQUIRED to change this: if Smaatech wants managers to see
// their reports' pay, that is a legitimate policy choice, but it should be an
// explicit one, and ideally scoped to an appraisal/increment cycle rather than
// granted permanently.
const MANAGER_HIDDEN_FIELDS = [
  'salary', 'basic', 'da', 'hra',
  'bankAccount', 'ifsc', 'bankName',
  'pan', 'uan', 'esiNumber', 'taxRegime',
];

function redactEmployee(doc, req) {
  const json = doc.toJSON ? doc.toJSON() : { ...doc };
  if (canSeeFullProfiles(req)) return json;
  // Your own record is always fully visible to you.
  if (req.auth.employeeId && String(json.id || json._id) === String(req.auth.employeeId)) return json;

  // A reporting manager sees their direct report's working details — the
  // information line management actually needs — but not their pay.
  if (req.auth.employeeId && json.managerId && String(json.managerId) === String(req.auth.employeeId)) {
    for (const field of MANAGER_HIDDEN_FIELDS) delete json[field];
    json.redactedFields = 'compensation';
    return json;
  }

  for (const field of SENSITIVE_EMPLOYEE_FIELDS) delete json[field];
  json.redacted = true;
  return json;
}

const SORT_MAP = {
  name: { name: 1 },
  dept: { dept: 1, name: 1 },
  salary: { salary: -1 },
  rating: { rating: -1 },
  newest: { joinDate: -1 },
};

/**
 * @openapi
 * /api/v1/employees:
 *   get:
 *     summary: List employees with optional search, sorting, and pagination
 *     tags: [Employees]
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
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of employees or paginated employee object
 */
router.get('/', async (req, res) => {
  const { page, limit, search, dept, sort } = req.query;

  // Legacy callers (loadAll()'s initial hydrate, and every dropdown/lookup
  // that needs the full roster — manager pickers, Attendance/Leave/Payroll
  // name joins, OrgChart, Analytics) get the same unpaginated array as
  // before. Only opt into paging/filtering when explicitly asked for it —
  // used today by the People Directory table's own search/pagination.
  if (!page && !limit) {
    const rows = await Employee.find(companyFilter(req)).sort({ createdAt: 1 });
    return res.json(rows.map((row) => redactEmployee(row, req)));
  }

  const filter = { ...companyFilter(req) };
  if (dept && dept !== 'All') filter.dept = dept;
  if (search) {
    const re = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { role: re }, { dept: re }, { loc: re }];
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Employee.find(filter).sort(SORT_MAP[sort] || SORT_MAP.name).skip((pageNum - 1) * limitNum).limit(limitNum),
    Employee.countDocuments(filter),
  ]);
  res.json({ rows: rows.map((row) => redactEmployee(row, req)), total, page: pageNum, limit: limitNum });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  }
  const row = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  // 200-with-null made "no such employee" and "employee with no data"
  // indistinguishable to the client.
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });
  res.json(redactEmployee(row, req));
});

router.post('/', requireRole('HR Manager'), validate(createEmployeeSchema), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };

  // A new hire starts on probation, ending at joinDate + the company's
  // configured probation length. Previously nothing tracked this at all, so
  // confirmation happened when somebody happened to remember it. The number
  // comes from Settings.employmentPolicy — never invented here.
  const policy = await employmentPolicy(req.auth.company);
  const probationStart = ISO_DATE_RE.test(String(body.joinDate || '')) ? body.joinDate : todayISO();
  if (!body.employmentStage) body.employmentStage = 'Probation';
  if (!body.probationEndDate && policy.probationMonths > 0) {
    body.probationEndDate = addMonths(probationStart, policy.probationMonths);
  }

  try {
    const created = await Employee.create(body);
    await logAudit(req, { action: 'Employee added', subject: created.name, after: created });

    // The start of employment is the first lifecycle event, recorded like
    // every other one rather than implied by a row appearing.
    if (created.employmentStage === 'Probation' && created.probationEndDate) {
      await LifecycleEvent.create({
        company: req.auth.company,
        empId: created._id,
        employeeName: created.name,
        type: 'probation-started',
        effectiveDate: probationStart,
        changes: {
          employmentStage: { from: null, to: 'Probation' },
          probationEndDate: { from: null, to: created.probationEndDate },
        },
        note: `${policy.probationMonths}-month probation per company policy`,
        dedupeKey: `probation-start:${created._id}`,
        actor: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
      }).catch(() => { /* the hire itself must not fail over its own history row */ });
    }

    res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'Another employee already has that email.' } });
    }
    throw err;
  }
});

// Serves two purposes: the allow-list for HR's bulk update below, and the
// deny-list stripped from a self-service PATCH.
//
// basic/da/hra/pfApplicable/pfOnFullWages are here because lib/statutory.js
// now computes PF and Professional Tax from them — leaving them
// self-editable would let an employee raise their own declared basic (and so
// their employer's PF liability) or switch PF off entirely from their own
// profile page. pan/uan/esiNumber and bank details stay self-editable on
// purpose: those are exactly the details employees are asked to supply.
const RESTRICTED_FIELDS = [
  'salary', 'basic', 'da', 'hra', 'pfApplicable', 'pfOnFullWages',
  'role', 'dept', 'loc', 'status', 'managerId', 'joinDate', 'rating',
  'employmentType', 'company', 'email', 'onboardingStatus',
];

router.post('/bulk-update', requireRole('HR Manager'), async (req, res) => {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !patch) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'ids array and patch body required.' } });
  }
  const scope = { _id: { $in: ids }, ...companyFilter(req) };
  const allowedPatch = {};
  RESTRICTED_FIELDS.forEach((f) => {
    if (patch[f] !== undefined) allowedPatch[f] = patch[f];
  });
  const result = await Employee.updateMany(scope, allowedPatch);
  await logAudit(req, {
    action: 'Bulk employees updated',
    subject: `${result.modifiedCount} employees`,
    details: Object.entries(allowedPatch).map(([k, v]) => `${k}: ${v}`).join(', '),
  });
  res.json({ updatedCount: result.modifiedCount });
});

// The only field a reporting manager may change on a direct report.
// HRMSContext.setLeaveStatus() fires employeesApi.update(empId, { status:
// 'on-leave' }) immediately after a successful approval, so without this a
// manager's approval succeeded and then threw on the follow-up write.
// Deliberately ONE field: this is not a general write grant over the team.
const MANAGER_PATCHABLE_FIELDS = ['status'];

router.patch('/:id', validate(patchEmployeeSchema), async (req, res) => {
  const isSelf = req.auth.employeeId && String(req.auth.employeeId) === String(req.params.id);
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);

  const before = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const isTheirManager = Boolean(req.auth.employeeId)
    && Boolean(before.managerId)
    && String(before.managerId) === String(req.auth.employeeId);

  if (!isHR && !isSelf && !isTheirManager) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to modify this profile.' } });
  }

  let patchBody = { ...(req.body || {}) };

  if (!isHR && !isSelf && isTheirManager) {
    for (const field of Object.keys(patchBody)) {
      if (!MANAGER_PATCHABLE_FIELDS.includes(field)) delete patchBody[field];
    }
    if (!Object.keys(patchBody).length) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'A reporting manager may only update the working status of a report.' },
      });
    }
  } else if (!isHR) {
    // Sanitize body for self-service updates to protect official fields
    RESTRICTED_FIELDS.forEach((field) => {
      delete patchBody[field];
    });
    // On self-service profile update after first login/activation, advance to Profile Completed
    if (['Created', 'Account Created', 'Invited', 'Activated', 'First Login'].includes(before.onboardingStatus)) {
      patchBody.onboardingStatus = 'Profile Completed';
    }
  }

  try {
    const updated = await Employee.findByIdAndUpdate(req.params.id, patchBody, { new: true });
    
    // Auto-sync Employee info (Name, Email) to linked User login account
    if (before.name !== updated.name || (updated.email && before.email !== updated.email)) {
      const userPatch = {};
      if (before.name !== updated.name) userPatch.name = updated.name.trim();
      if (updated.email && before.email !== updated.email) userPatch.email = String(updated.email).toLowerCase().trim();
      await User.findOneAndUpdate({ employeeId: updated._id }, userPatch);
    }

    // Construct specific audit detail summary for sensitive field changes
    const changes = [];
    if (before.salary !== updated.salary) changes.push(`Salary: ₹${before.salary} -> ₹${updated.salary}`);
    if (before.role !== updated.role) changes.push(`Role: ${before.role} -> ${updated.role}`);
    if (before.dept !== updated.dept) changes.push(`Dept: ${before.dept} -> ${updated.dept}`);
    if (before.status !== updated.status) changes.push(`Status: ${before.status} -> ${updated.status}`);
    if (before.onboardingStatus !== updated.onboardingStatus) changes.push(`Onboarding: ${before.onboardingStatus || 'Created'} -> ${updated.onboardingStatus}`);
    const details = changes.length ? changes.join(' | ') : 'Profile details updated';

    await logAudit(req, { action: 'Employee updated', subject: updated.name, details, before, after: updated });
    res.json(updated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'Another employee already has that email.' } });
    }
    throw err;
  }
});

router.post('/:id/verify-onboarding', requireRole('HR Manager'), async (req, res) => {
  const before = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  const updated = await Employee.findByIdAndUpdate(
    req.params.id,
    { onboardingStatus: 'HR Verified', status: 'active' },
    { new: true },
  );

  await logAudit(req, {
    action: 'Employee onboarding verified',
    subject: updated.name,
    details: `Onboarding Status: HR Verified | Employment Status: Active`,
    before,
    after: updated,
  });

  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.json({ id: req.params.id });
  }
  const before = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.json({ id: req.params.id });

  const soft = req.query.soft === 'true';

  // Whether the employee record is archived or removed, the person is gone —
  // so their LOGIN must stop working. Previously neither path touched the
  // linked User account or its refresh tokens, leaving a fully working set of
  // credentials for someone who no longer works here (and, on a hard delete,
  // a User row pointing at an employee that no longer exists).
  const linkedUser = await User.findOne({ employeeId: before._id, ...companyFilter(req) });
  if (linkedUser) {
    linkedUser.active = false;
    linkedUser.status = 'Inactive';
    if (!soft) linkedUser.employeeId = null;
    await linkedUser.save();
    await terminateAllAccess(linkedUser._id, { reason: soft ? 'employee terminated' : 'employee record deleted' });
  }

  if (soft) {
    before.status = 'terminated';
    await before.save();
    await logAudit(req, {
      action: 'Employee soft-deleted (terminated)',
      subject: before.name,
      details: linkedUser ? 'Linked login deactivated and all sessions revoked.' : 'No linked login.',
      before,
    });
  } else {
    // Direct reports would otherwise point at a manager that no longer exists.
    await Employee.updateMany({ managerId: before._id, ...companyFilter(req) }, { managerId: null });
    await Employee.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
    await logAudit(req, {
      action: 'Employee removed',
      subject: before.name,
      details: linkedUser ? 'Linked login deactivated, unlinked and all sessions revoked.' : 'No linked login.',
      before,
    });
  }

  res.json({ id: req.params.id });
});

export default router;

