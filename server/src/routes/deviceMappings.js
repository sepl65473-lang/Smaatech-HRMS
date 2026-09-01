import { Router } from 'express';
import DeviceUserMapping from '../models/DeviceUserMapping.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

// Persisted device-user links — Integrations.jsx's "unmapped punch -> link
// employee" UI used to only hold this in local React state (lost on reload);
// this is what lets a real device-punch ingest resolve deviceUserId -> empId
// on its own from here on.
const router = Router();
router.use(requireAuth);

router.get('/', requireRole('HR Manager'), async (req, res) => {
  const rows = await DeviceUserMapping.find(companyFilter(req)).sort({ createdAt: -1 });
  res.json(rows);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const { deviceId, deviceUserId, empId } = req.body || {};
  if (!deviceId || !deviceUserId || !empId) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'deviceId, deviceUserId, and empId are required.' } });
  }
  const created = await DeviceUserMapping.findOneAndUpdate(
    { company: req.auth.company, deviceId, deviceUserId },
    { empId },
    { upsert: true, new: true },
  );
  await logAudit(req, { action: 'Device user mapped', subject: deviceUserId, after: created });
  res.status(201).json(created);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const deleted = await DeviceUserMapping.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found.' } });
  await logAudit(req, { action: 'Device mapping removed', subject: deleted.deviceUserId, before: deleted });
  res.json({ id: req.params.id });
});

export default router;
