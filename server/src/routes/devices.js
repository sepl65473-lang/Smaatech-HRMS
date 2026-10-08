import { Router } from 'express';
import crypto from 'node:crypto';
import Device from '../models/Device.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

// HR/Admin register of attendance machines. A device authenticates to
// POST /device-punch with its own id and key; this is where that id, key and
// the site the machine is mounted at are managed.
const router = Router();
router.use(requireAuth);
router.use(requireRole('HR Manager'));

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;

export const hashDeviceKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const newKey = () => crypto.randomBytes(32).toString('hex');

function readSite(body) {
  const siteAddress = String(body?.siteAddress ?? '').trim();
  if (siteAddress.length < 3 || siteAddress.length > 300) {
    return { error: 'siteAddress is required: the place this device is mounted at (3 to 300 characters).' };
  }
  const blank = (v) => v === undefined || v === null || v === '';
  if (blank(body?.siteLat) && blank(body?.siteLng)) return { siteAddress, siteLat: null, siteLng: null };
  const siteLat = Number(body.siteLat);
  const siteLng = Number(body.siteLng);
  if (blank(body?.siteLat) || blank(body?.siteLng) || !Number.isFinite(siteLat) || !Number.isFinite(siteLng)
    || Math.abs(siteLat) > 90 || Math.abs(siteLng) > 180) {
    return { error: 'siteLat and siteLng must both be given as valid coordinates, or both left empty.' };
  }
  return { siteAddress, siteLat, siteLng };
}

const bad = (res, message) => res.status(400).json({ error: { code: 'BAD_REQUEST', message } });

router.get('/', async (req, res) => {
  res.json(await Device.find(companyFilter(req)).sort({ createdAt: -1 }));
});

// Registers a device and returns its key ONCE. Only a hash is stored.
router.post('/', async (req, res) => {
  const deviceId = String(req.body?.deviceId ?? '').trim();
  const name = String(req.body?.name ?? '').trim();
  if (!DEVICE_ID.test(deviceId)) return bad(res, 'deviceId must be 3 to 40 characters: letters, digits, dot, dash or underscore.');
  if (name.length < 2 || name.length > 80) return bad(res, 'name is required (2 to 80 characters).');
  const site = readSite(req.body);
  if (site.error) return bad(res, site.error);
  if (await Device.exists({ deviceId })) {
    return res.status(409).json({ error: { code: 'DEVICE_EXISTS', message: 'A device with this id is already registered.' } });
  }
  const key = newKey();
  const created = await Device.create({ deviceId, name, ...site, keyHash: hashDeviceKey(key), company: req.auth.company });
  await logAudit(req, { action: 'Attendance device registered', subject: `${name} (${deviceId})`, details: site.siteAddress });
  res.status(201).json({ ...created.toJSON(), deviceKey: key });
});

router.patch('/:id', async (req, res) => {
  const device = await Device.findOne({ _id: req.params.id, ...companyFilter(req) }).catch(() => null);
  if (!device) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found.' } });
  const changes = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (name.length < 2 || name.length > 80) return bad(res, 'name must be 2 to 80 characters.');
    device.name = name; changes.push('name');
  }
  if (req.body?.siteAddress !== undefined || req.body?.siteLat !== undefined || req.body?.siteLng !== undefined) {
    const site = readSite({ siteAddress: device.siteAddress, siteLat: device.siteLat, siteLng: device.siteLng, ...req.body });
    if (site.error) return bad(res, site.error);
    Object.assign(device, site); changes.push('site');
  }
  if (req.body?.active !== undefined) {
    device.active = Boolean(req.body.active); changes.push(device.active ? 'enabled' : 'disabled');
  }
  await device.save();
  await logAudit(req, { action: 'Attendance device updated', subject: `${device.name} (${device.deviceId})`, details: changes.join(', ') || 'no change' });
  res.json(device);
});

// A new key replaces the old one immediately; the old one stops working.
router.post('/:id/key', async (req, res) => {
  const device = await Device.findOne({ _id: req.params.id, ...companyFilter(req) }).catch(() => null);
  if (!device) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found.' } });
  const key = newKey();
  device.keyHash = hashDeviceKey(key);
  await device.save();
  await logAudit(req, { action: 'Attendance device key regenerated', subject: `${device.name} (${device.deviceId})` });
  res.json({ ...device.toJSON(), deviceKey: key });
});

export default router;
