import { Router } from 'express';
import Expense from '../models/Expense.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { pickFields, isSelf } from '../lib/patchGuard.js';
import { validate } from '../middleware/validation.js';
import { fileExpenseSchema } from '../validations/expenseValidation.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';

// Falls back to this sequence when HR hasn't configured Settings > Workflows
// yet — matches the default the Workflows page itself shows unconfigured.
const DEFAULT_STAGES = ['Finance Lead', 'HR Director'];

function stagesFor(expense) {
  return expense.approvalStages?.length ? expense.approvalStages : DEFAULT_STAGES;
}

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const canActForOthers = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const scope = { ...companyFilter(req), ...(canActForOthers ? {} : { empId: req.auth.employeeId }) };
  const { page, limit, status } = req.query;

  const filter = { ...scope };
  if (status) filter.status = status;

  if (!page && !limit) {
    const DEFAULT_CAP = 100;
    const rows = await Expense.find(filter).sort({ createdAt: -1 }).limit(DEFAULT_CAP);
    return res.json(rows);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    Expense.countDocuments(filter),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
});

router.get('/:id', async (req, res) => {
  const row = await Expense.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

// Any authenticated user may file their own expense claim; only
// HR Manager/Finance Lead/Director can file one on someone else's behalf.
// Self-service claims are always created 'pending' — `status` is never
// taken from the request body, so an employee can't self-approve.
router.post('/', validate(fileExpenseSchema), async (req, res) => {
  const canActForOthers = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const { empId, name, category, amount, date, description } = req.body || {};
  if (!canActForOthers && empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file expenses for yourself.' } });
  }
  const settingsDoc = await getSettingsDoc(req.auth.company);
  const created = await Expense.create({
    status: 'pending', reason: '',
    empId, name, category, amount, date, description,
    company: req.auth.company,
    approvalStages: settingsDoc.approvalWorkflows?.expense?.length ? settingsDoc.approvalWorkflows.expense : DEFAULT_STAGES,
    currentStage: 0,
    ...(canActForOthers ? { status: req.body?.status } : {}),
  });
  await logAudit(req, { action: 'Expense requested', subject: created.name, after: created });
  res.status(201).json(created);
});

// Deliberately cannot set `status`, `approvals` or `currentStage`: the old
// handler passed req.body straight through, so an HR Manager could flip a
// claim to 'approved' here and skip every approval stage and its permission
// check. Decisions go through /approve and /decline.
const EXPENSE_PATCH_FIELDS = ['name', 'category', 'amount', 'date', 'description'];

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Expense.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });

  const updated = await Expense.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    pickFields(req.body, EXPENSE_PATCH_FIELDS),
    { new: true },
  );
  await logAudit(req, { action: 'Expense updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

// Stage-aware approve/decline — the caller must hold the role the claim's
// current stage requires (HR Director always may, as the app-wide superuser).
router.post('/:id/approve', async (req, res) => {
  const expense = await Expense.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!expense) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  if (expense.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This claim has already been decided.' } });
  }
  const stages = stagesFor(expense);
  const requiredRole = stages[expense.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = expense.toObject ? expense.toObject() : JSON.parse(JSON.stringify(expense));
  // Same self-approval hole leave had: an HR Manager or Finance Lead filing
  // their own claim satisfied their own stage and could approve their own
  // reimbursement in one click.
  if (isSelf(req, expense.empId)) {
    return res.status(403).json({ error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot approve your own expense claim.' } });
  }
  expense.approvals.push({ role: req.auth.role, decision: 'approved', by: req.auth.name });
  expense.currentStage += 1;
  if (expense.currentStage >= stages.length) expense.status = 'approved';
  await expense.save();

  await logAudit(req, { 
    action: `Expense ${expense.status === 'approved' ? 'approved' : 'stage approved'}`, 
    subject: expense.name, 
    before, 
    after: expense 
  });
  res.json(expense);
});

router.post('/:id/decline', async (req, res) => {
  const expense = await Expense.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!expense) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  if (expense.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This claim has already been decided.' } });
  }
  const stages = stagesFor(expense);
  const requiredRole = stages[expense.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = expense.toObject ? expense.toObject() : JSON.parse(JSON.stringify(expense));
  if (isSelf(req, expense.empId)) {
    return res.status(403).json({ error: { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot decline your own expense claim.' } });
  }
  // A declined reimbursement with no stated reason leaves the claimant with
  // nothing to act on.
  const declineReason = String(req.body?.reason || '').trim();
  if (!declineReason) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required when declining an expense claim.' } });
  }
  expense.approvals.push({ role: req.auth.role, decision: 'declined', by: req.auth.name });
  expense.status = 'declined';
  expense.reason = declineReason;
  await expense.save();

  await logAudit(req, { action: 'Expense declined', subject: expense.name, before, after: expense });
  res.json(expense);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Expense.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await Expense.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Expense deleted', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
