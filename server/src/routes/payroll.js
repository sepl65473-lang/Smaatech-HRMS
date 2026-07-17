import { Router } from 'express';
import Payroll from '../models/Payroll.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const canSeeAll = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const rows = await Payroll.find(canSeeAll ? {} : { empId: req.auth.employeeId }).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Payroll.findById(req.params.id);
  res.json(row || null);
});

// HR Manager needs this too — addEmployee/updateEmployee/deleteEmployee (all
// gated to HR Manager on /employees) cascade payroll row create/patch/delete
// for denormalization sync, alongside Finance Lead's own process/pay actions.
router.post('/', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const created = await Payroll.create(req.body || {});
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const updated = await Payroll.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  await Payroll.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
