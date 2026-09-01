import { Router } from 'express';
import crypto from 'node:crypto';
import Settings from '../models/Settings.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

import { logAudit } from '../lib/auditLogger.js';

const router = Router();

const SERVER_OWNED_KEYS = [
  'gpsCheckInEnabled', 'geofenceLat', 'geofenceLng', 'geofenceRadius',
  'shifts', 'roster', 'employeeShifts', 'approvalWorkflows',
  'orgName', 'workWeek', 'notifyLeave', 'notifyPayroll', 'notifyBirthday', 'twoFactor',
  'wishesSent', 'totalLeaveDays', 'departments', 'designations',
  'gatewayTwilioSid', 'gatewayTwilioToken', 'gatewayTwilioFrom', 'gatewaySendgridKey',
  'gatewaySmtpHost', 'gatewaySmtpUser', 'gatewaySmtpPass',
  'notificationTemplates', 'notifyChannels'
];

export async function getSettingsDoc(company = 'Smaatech') {
  let doc = await Settings.findById(company);
  if (!doc) doc = await Settings.create({ _id: company });
  return doc;
}

router.get('/', requireAuth, async (req, res) => {
  const doc = await getSettingsDoc(req.auth.company);
  const json = doc.toJSON();
  // GET /settings is readable by every authenticated role (the whole app
  // reads gpsCheckInEnabled, shifts, etc. from it) — a device secret has no
  // business being in a response a plain Employee can request. It's only
  // ever returned directly from POST /device-key/regenerate below.
  delete json.biometricDeviceApiKey;
  res.json(json);
});

router.patch('/', requireAuth, requireRole('HR Manager'), async (req, res) => {
  const patch = {};
  for (const key of SERVER_OWNED_KEYS) {
    if (req.body && key in req.body) patch[key] = req.body[key];
  }
  const company = req.auth.company;
  const before = await getSettingsDoc(company);
  const doc = await Settings.findByIdAndUpdate(company, patch, { new: true, upsert: true });
  await logAudit(req, { action: 'Settings updated', subject: 'System Settings', before, after: doc });
  res.json(doc);
});

// Server-generated only — never settable via the generic PATCH above, so a
// weak/guessable key can't be typed in through the request body. The plain
// key is only ever returned here, right after generation, for HR to copy
// into the device bridge's config; it's not re-shown by GET /settings.
router.post('/device-key/regenerate', requireAuth, requireRole('HR Manager'), async (req, res) => {
  const company = req.auth.company;
  const biometricDeviceApiKey = crypto.randomBytes(24).toString('hex');
  await Settings.findByIdAndUpdate(company, { biometricDeviceApiKey }, { upsert: true });
  await logAudit(req, { action: 'Biometric device key regenerated', subject: 'System Settings' });
  res.json({ biometricDeviceApiKey });
});

export default router;

