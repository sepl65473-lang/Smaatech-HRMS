import { Router } from 'express';
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
  res.json(await getSettingsDoc(req.auth.company));
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

export default router;

