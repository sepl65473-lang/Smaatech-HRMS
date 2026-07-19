import { Router } from 'express';
import Job from '../models/Job.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const rows = await Job.find(companyFilter(req)).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Job.findById(req.params.id);
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Job.create({ status: 'Open', ...req.body, company: req.auth.company });
  await logAudit(req, { action: 'Job posting added', subject: created.title, after: created });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Job.findById(req.params.id);
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job posting not found.' } });

  const updated = await Job.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  const isStatusChanged = before.status !== updated.status;
  const actionName = isStatusChanged ? 'Job status updated' : 'Job posting updated';
  await logAudit(req, { action: actionName, subject: updated.title, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Job.findById(req.params.id);
  if (before) {
    await Job.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Job posting deleted', subject: before.title, before });
  }
  res.json({ id: req.params.id });
});

export default router;
