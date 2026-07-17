import { Router } from 'express';
import Expense from '../models/Expense.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSettingsDoc } from './settings.js';

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
  const rows = await Expense.find(canActForOthers ? {} : { empId: req.auth.employeeId }).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Expense.findById(req.params.id);
  res.json(row || null);
});

// Any authenticated user may file their own expense claim; only
// HR Manager/Finance Lead/Director can file one on someone else's behalf.
// Self-service claims are always created 'pending' — `status` is never
// taken from the request body, so an employee can't self-approve.
router.post('/', async (req, res) => {
  const canActForOthers = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const { empId, name, category, amount, date, description } = req.body || {};
  if (!canActForOthers && empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file expenses for yourself.' } });
  }
  const settingsDoc = await getSettingsDoc();
  const created = await Expense.create({
    status: 'pending', reason: '',
    empId, name, category, amount, date, description,
    approvalStages: settingsDoc.approvalWorkflows?.expense?.length ? settingsDoc.approvalWorkflows.expense : DEFAULT_STAGES,
    currentStage: 0,
    ...(canActForOthers ? { status: req.body?.status } : {}),
  });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const updated = await Expense.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  res.json(updated);
});

// Stage-aware approve/decline — the caller must hold the role the claim's
// current stage requires (HR Director always may, as the app-wide superuser).
router.post('/:id/approve', async (req, res) => {
  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  if (expense.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This claim has already been decided.' } });
  }
  const stages = stagesFor(expense);
  const requiredRole = stages[expense.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  expense.approvals.push({ role: req.auth.role, decision: 'approved' });
  expense.currentStage += 1;
  if (expense.currentStage >= stages.length) expense.status = 'approved';
  await expense.save();
  res.json(expense);
});

router.post('/:id/decline', async (req, res) => {
  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  if (expense.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This claim has already been decided.' } });
  }
  const stages = stagesFor(expense);
  const requiredRole = stages[expense.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  expense.approvals.push({ role: req.auth.role, decision: 'declined' });
  expense.status = 'declined';
  expense.reason = req.body?.reason || expense.reason;
  await expense.save();
  res.json(expense);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  await Expense.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
