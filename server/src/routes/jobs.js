import { Router } from 'express';
import Job from '../models/Job.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Job.find().sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Job.findById(req.params.id);
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Job.create({ status: 'Open', ...req.body });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Job.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job posting not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Job.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
