import { Router } from 'express';
import Holiday from '../models/Holiday.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Holiday.find().sort({ createdAt: 1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Holiday.findById(req.params.id);
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Holiday.create(req.body || {});
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Holiday.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Holiday not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Holiday.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
