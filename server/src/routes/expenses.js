import { Router } from 'express';
import Expense from '../models/Expense.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Expense.find().sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Expense.findById(req.params.id);
  res.json(row || null);
});

// Any authenticated user may file their own expense claim; only
// HR Manager/Finance Lead/Director can file one on someone else's behalf.
router.post('/', async (req, res) => {
  const canActForOthers = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  if (!canActForOthers && req.body?.empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file expenses for yourself.' } });
  }
  const created = await Expense.create({ status: 'pending', reason: '', ...req.body });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const updated = await Expense.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Expense claim not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  await Expense.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
