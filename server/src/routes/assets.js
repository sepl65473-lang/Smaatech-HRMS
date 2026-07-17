import { Router } from 'express';
import Asset from '../models/Asset.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Asset.find().sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Asset.findById(req.params.id);
  res.json(row || null);
});

router.post('/', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const created = await Asset.create({
    status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '', ...req.body,
  });
  res.status(201).json(created);
});

// assignAsset/returnAsset both send a plain 4-field patch (status + the 3
// assignment fields together) — generic merge-patch handles both directions.
router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const updated = await Asset.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  await Asset.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
