import { Router } from 'express';
import Holiday from '../models/Holiday.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const rows = await Holiday.find(companyFilter(req)).sort({ createdAt: 1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Holiday.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };
  const created = await Holiday.create(body);
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Holiday.findOneAndUpdate({ _id: req.params.id, ...companyFilter(req) }, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Holiday not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Holiday.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  res.json({ id: req.params.id });
});

export default router;
