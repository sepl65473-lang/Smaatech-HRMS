import { Router } from 'express';
import Leave from '../models/Leave.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const rows = await Leave.find(isManager ? {} : { empId: req.auth.employeeId }).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Leave.findById(req.params.id);
  res.json(row || null);
});

// Any authenticated user may file their own leave request (see MyDashboard's
// employee self-service flow); only HR Manager/Director can file on behalf
// of someone else. Self-service requests are always created 'pending' —
// `status` is never taken from the request body, so an employee can't
// submit an already-'approved' request for themselves.
router.post('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const { empId, name, dept, type, start, end, reason } = req.body || {};
  if (!isManager && empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file leave for yourself.' } });
  }
  const created = await Leave.create({
    empId, name, dept, type, start, end, reason,
    ...(isManager ? { status: req.body?.status } : {}),
  });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Leave.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Leave.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
