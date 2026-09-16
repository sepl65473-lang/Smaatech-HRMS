import { Router } from 'express';
import Asset from '../models/Asset.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { pickFields } from '../lib/patchGuard.js';

// `company` is excluded so a patch cannot move an asset into another tenant.
const ASSET_PATCH_FIELDS = ['name', 'category', 'serialNumber', 'status', 'assignedToEmpId', 'assignedToEmpName', 'assignedDate'];

import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

// The asset register carries serial numbers, purchase costs and who holds
// what — HR/Finance information, not something every colleague needs.
// Employees see only assets assigned to them.
router.get('/', async (req, res) => {
  const canSeeAll = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const scope = canSeeAll
    ? companyFilter(req)
    : { ...companyFilter(req), ...(req.auth.employeeId ? { assignedToEmpId: req.auth.employeeId } : { _id: null }) };
  const rows = await Asset.find(scope).sort({ createdAt: -1 });
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

  const updated = await Asset.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    pickFields(req.body, ASSET_PATCH_FIELDS),
    { new: true },
  );
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
