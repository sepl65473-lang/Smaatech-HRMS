import { Router } from 'express';
import Asset from '../models/Asset.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const rows = await Asset.find(companyFilter(req)).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Asset.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

router.post('/', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const created = await Asset.create({
    status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '', ...req.body, company: req.auth.company,
  });
  await logAudit(req, { action: 'Asset added', subject: created.name, after: created });
  res.status(201).json(created);
});

// assignAsset/returnAsset both send a plain 4-field patch (status + the 3
// assignment fields together) — generic merge-patch handles both directions.
router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Asset.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });

  const updated = await Asset.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  let actionName = 'Asset updated';
  if (before.status !== 'assigned' && updated.status === 'assigned') {
    actionName = 'Asset assigned';
  } else if (before.status === 'assigned' && updated.status !== 'assigned') {
    actionName = 'Asset returned';
  }
  await logAudit(req, { action: actionName, subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Asset.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await Asset.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Asset deleted', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
