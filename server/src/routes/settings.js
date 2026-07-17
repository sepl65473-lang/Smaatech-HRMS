import { Router } from 'express';
import Settings from '../models/Settings.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const SERVER_OWNED_KEYS = [
  'gpsCheckInEnabled', 'geofenceLat', 'geofenceLng', 'geofenceRadius',
  'shifts', 'roster', 'employeeShifts', 'approvalWorkflows',
];

export async function getSettingsDoc() {
  let doc = await Settings.findById('singleton');
  if (!doc) doc = await Settings.create({ _id: 'singleton' });
  return doc;
}

router.get('/', requireAuth, async (_req, res) => {
  res.json(await getSettingsDoc());
});

router.patch('/', requireAuth, requireRole('HR Manager'), async (req, res) => {
  const patch = {};
  for (const key of SERVER_OWNED_KEYS) {
    if (req.body && key in req.body) patch[key] = req.body[key];
  }
  const doc = await Settings.findByIdAndUpdate('singleton', patch, { new: true, upsert: true });
  res.json(doc);
});

export default router;
