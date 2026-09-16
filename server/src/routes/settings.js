import { Router } from 'express';
import crypto from 'node:crypto';
import Settings from '../models/Settings.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getCache, setCache, invalidateCache } from '../lib/cacheStore.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();

const SERVER_OWNED_KEYS = [
  'gpsCheckInEnabled', 'livenessRequired', 'geofenceLat', 'geofenceLng', 'geofenceRadius',
  'shifts', 'roster', 'employeeShifts', 'approvalWorkflows',
  'orgName', 'workWeek', 'notifyLeave', 'notifyPayroll', 'notifyBirthday', 'twoFactor',
  'wishesSent', 'totalLeaveDays', 'leaveYearStartMonth', 'departments', 'designations',
  'gatewayTwilioSid', 'gatewayTwilioToken', 'gatewayTwilioFrom', 'gatewaySendgridKey',
  'gatewaySmtpHost', 'gatewaySmtpUser', 'gatewaySmtpPass',
  'notificationTemplates', 'notifyChannels'
];

export async function getSettingsDoc(company = 'Smaatech') {
  const isTest = process.env.NODE_ENV === 'test';
  const cacheKey = `settings:${company}`;
  const cached = !isTest && getCache(cacheKey);
  if (cached) return cached;

  let doc = await Settings.findById(company);
  if (!doc) doc = await Settings.create({ _id: company });
  if (!isTest) setCache(cacheKey, doc, 5 * 60 * 1000);
  return doc;
}

// Third-party gateway credentials stored on the settings document. GET
// /settings is readable by EVERY authenticated role (the whole app reads
// gpsCheckInEnabled, shifts, workWeek and so on from it), so previously any
// plain Employee could request this endpoint and read the company's live
// SMTP password, Twilio auth token and SendGrid API key in cleartext —
// enough to send mail as the company or run up its telephony bill.
// Only biometricDeviceApiKey was being stripped.
const SECRET_SETTINGS_KEYS = [
  'biometricDeviceApiKey',
  'gatewayTwilioSid', 'gatewayTwilioToken', 'gatewayTwilioFrom',
  'gatewaySendgridKey',
  'gatewaySmtpHost', 'gatewaySmtpUser', 'gatewaySmtpPass',
];

// Never echo a stored secret back, even to an admin — the UI only needs to
// know whether one is configured, so it can render "Configured"/"Not set"
// without the value ever leaving the server again after it was written.
function redactSecrets(json, { includeStatus = false } = {}) {
  const status = {};
  for (const key of SECRET_SETTINGS_KEYS) {
    status[key] = Boolean(json[key]);
    delete json[key];
  }
  if (includeStatus) json.secretsConfigured = status;
  return json;
}

router.get('/', requireAuth, async (req, res) => {
  const doc = await getSettingsDoc(req.auth.company);
  const json = doc.toJSON();
  const isAdmin = ['HR Director', 'HR Manager'].includes(req.auth.role);
  res.json(redactSecrets(json, { includeStatus: isAdmin }));
});

router.patch('/', requireAuth, requireRole('HR Manager'), async (req, res) => {
  const patch = {};
  for (const key of SERVER_OWNED_KEYS) {
    if (req.body && key in req.body) patch[key] = req.body[key];
  }

  // Write-only secrets: blank means "leave unchanged", never "erase".
  //
  // GET /settings redacts these, so Settings.jsx seeds its inputs from
  // undefined and renders them EMPTY. Its "Save Credentials" button then
  // PATCHes all six fields back as '' — which without this rule silently
  // destroyed the company's live SMTP password and Twilio auth token, and
  // stopped all outbound email. Rotating a secret still works: send a value.
  for (const key of SECRET_SETTINGS_KEYS) {
    if (key in patch && String(patch[key] ?? '').trim() === '') delete patch[key];
  }
  const company = req.auth.company;
  const before = await getSettingsDoc(company);
  const doc = await Settings.findByIdAndUpdate(company, patch, { new: true, upsert: true, runValidators: true });
  invalidateCache(`settings:${company}`);
  // before/after land verbatim in the audit trail, so redact there too —
  // otherwise the secrets just move from the API response into AuditLog rows
  // that /audit-logs then serves.
  await logAudit(req, {
    action: 'Settings updated',
    subject: 'System Settings',
    before: redactSecrets(before.toJSON()),
    after: redactSecrets(doc.toJSON()),
  });
  res.json(redactSecrets(doc.toJSON(), { includeStatus: true }));
});

// Server-generated only — never settable via the generic PATCH above, so a
// weak/guessable key can't be typed in through the request body. The plain
// key is only ever returned here, right after generation, for HR to copy
// into the device bridge's config; it's not re-shown by GET /settings.
router.post('/device-key/regenerate', requireAuth, requireRole('HR Manager'), async (req, res) => {
  const company = req.auth.company;
  const biometricDeviceApiKey = crypto.randomBytes(24).toString('hex');
  await Settings.findByIdAndUpdate(company, { biometricDeviceApiKey }, { upsert: true });
  invalidateCache(`settings:${company}`);
  await logAudit(req, { action: 'Biometric device key regenerated', subject: 'System Settings' });
  res.json({ biometricDeviceApiKey });
});

export default router;

