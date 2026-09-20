import { Router } from 'express';
import User from '../models/User.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import FaceAccessGrant, { grantStatus } from '../models/FaceAccessGrant.js';
import { extractDescriptor, faceFailureMessage } from '../lib/faceEngine.js';
import { savePhoto, imageUploadMiddleware } from '../lib/photoStorage.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
const upload = imageUploadMiddleware('photo', 'Enrollment photo must be a JPEG, PNG, or WebP image.');
const MAX_GRANT_HOURS = 168; // 7 days
const DEFAULT_GRANT_HOURS = 24;

router.use(requireAuth);

const isHrRole = (role) => role === 'HR Director' || role === 'HR Manager';

/** The one grant that would let this account re-enrol right now, or null. */
async function activeGrantFor(userId) {
  const grant = await FaceAccessGrant.findOne({
    userId, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  return grant || null;
}

// -- HR/Admin-controlled re-verification access ------------------------------
// Granting access does NOT verify anybody: the employee still completes the
// same enrolment flow, and the descriptor is still computed server-side from
// the photo they present.

router.post('/access', requireRole('HR Manager'), async (req, res) => {
  const { userId, email, reason } = req.body || {};
  const hours = Math.min(MAX_GRANT_HOURS, Math.max(1, Number(req.body?.hours) || DEFAULT_GRANT_HOURS));
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required so the grant can be audited.' } });
  }

  const target = userId
    ? await User.findOne({ _id: userId, ...companyFilter(req) })
    : await User.findOne({ email: String(email || '').toLowerCase().trim(), ...companyFilter(req) });
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (String(target._id) === String(req.auth.sub)) {
    // Nobody hands themselves this, HR included: that would make the control
    // meaningless for the accounts that administer attendance.
    return res.status(403).json({ error: { code: 'SELF_GRANT_FORBIDDEN', message: 'You cannot grant face re-verification access to your own account. Ask another HR user.' } });
  }

  // One live grant per account: re-granting replaces the previous window
  // rather than stacking several.
  const existing = await activeGrantFor(target._id);
  if (existing) {
    existing.revokedAt = new Date();
    existing.revokedBy = { id: String(req.auth.sub), name: req.auth.name || null };
    await existing.save();
  }

  const grant = await FaceAccessGrant.create({
    userId: target._id,
    employeeId: target.employeeId || null,
    subjectName: target.name,
    subjectEmail: target.email,
    reason: String(reason).trim().slice(0, 500),
    expiresAt: new Date(Date.now() + hours * 3600 * 1000),
    grantedBy: { id: String(req.auth.sub), name: req.auth.name || null, role: req.auth.role || null },
    company: target.company,
  });

  await logAudit(req, {
    action: 'Face re-verification access granted',
    subject: target.name,
    details: `${hours}h access for ${target.email} — reason: ${grant.reason}`,
    after: grant,
  });
  res.status(201).json(grant);
});

// HR view: every grant, or one account's history with ?userId=
router.get('/access', requireRole('HR Manager'), async (req, res) => {
  const filter = { ...companyFilter(req) };
  if (req.query.userId) filter.userId = req.query.userId;
  const grants = await FaceAccessGrant.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json(grants);
});

// What the employee's own portal asks: may I re-verify right now?
router.get('/access/me', async (req, res) => {
  const [grant, descriptor] = await Promise.all([
    activeGrantFor(req.auth.sub),
    FaceDescriptor.findOne({ userId: req.auth.sub }).select('enrolledAt'),
  ]);
  res.json({
    enrolled: Boolean(descriptor),
    // A first enrolment never needed permission and still does not.
    canEnrol: !descriptor || Boolean(grant),
    grant: grant || null,
  });
});

router.delete('/access/:id', requireRole('HR Manager'), async (req, res) => {
  const grant = await FaceAccessGrant.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!grant) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Access grant not found.' } });
  if (grantStatus(grant) !== 'active') {
    return res.status(409).json({ error: { code: 'NOT_ACTIVE', message: `This grant is already ${grantStatus(grant)}.` } });
  }
  grant.revokedAt = new Date();
  grant.revokedBy = { id: String(req.auth.sub), name: req.auth.name || null };
  await grant.save();
  await logAudit(req, {
    action: 'Face re-verification access revoked',
    subject: grant.subjectName,
    details: `Access for ${grant.subjectEmail} revoked before use`,
    after: grant,
  });
  res.json(grant);
});

// Enrolls the caller's own face by default; HR Manager/Director may pass
// { userId } or { email } to enroll on behalf of another account (mirrors
// the old Settings > Users admin-assisted enrollment — the Settings page's
// local login-profile records don't carry a server User id, only an email,
// so both lookups are supported). Either way, the descriptor is computed
// here, server-side, from the uploaded photo — never accepted as a
// client-supplied value.
router.post('/enroll', upload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: { code: 'NO_PHOTO', message: 'No photo uploaded.' } });
  }
  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';

  let target;
  if (isAdmin && req.body.userId) {
    target = await User.findOne({ _id: req.body.userId, ...companyFilter(req) });
  } else if (isAdmin && req.body.email) {
    target = await User.findOne({ email: String(req.body.email).toLowerCase().trim(), ...companyFilter(req) });
  } else {
    target = await User.findById(req.auth.sub);
  }
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  const targetUserId = target._id;

  // Replacing an existing template on your OWN account needs an HR/Admin
  // grant. A first enrolment does not, and an HR-assisted enrolment for
  // someone else does not: both are unchanged.
  const isSelfEnrolment = String(targetUserId) === String(req.auth.sub);
  const existingTemplate = await FaceDescriptor.findOne({ userId: targetUserId }).select('_id');
  let grantInUse = null;
  if (isSelfEnrolment && existingTemplate) {
    grantInUse = await activeGrantFor(targetUserId);
    if (!grantInUse) {
      return res.status(403).json({
        error: {
          code: 'REVERIFICATION_NOT_AUTHORISED',
          message: 'Your face is already enrolled. Ask HR to grant face re-verification access before enrolling again.',
        },
      });
    }
  }

  const result = await extractDescriptor(req.file.buffer);
  if (result.error) {
    return res.status(400).json({ error: { code: result.error, message: faceFailureMessage(result.error) } });
  }

  const photoRef = await savePhoto('enrollment', `${targetUserId}.jpg`, req.file.buffer);
  await FaceDescriptor.findOneAndUpdate(
    { userId: targetUserId },
    { descriptor: result.descriptor, photoRef, enrolledAt: new Date() },
    { upsert: true },
  );

  // Spent on success only: a failed capture leaves the grant usable, so the
  // employee is not locked out by one bad photo.
  if (grantInUse) {
    grantInUse.usedAt = new Date();
    await grantInUse.save();
    await logAudit(req, {
      action: 'Face re-verification access used',
      subject: target.name,
      details: `Re-enrolment completed under access granted by ${grantInUse.grantedBy?.name || 'HR'}`,
      after: grantInUse,
    });
  }

  await logAudit(req, {
    action: 'Biometric face template enrolled',
    subject: target.name,
    details: `Biometric template updated for account ${target.email}`,
  });

  res.json({ ok: true, enrolledFor: target.name });
});

router.get('/status/:userId', async (req, res) => {
  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isSelf = req.auth.sub === req.params.userId;
  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
  }
  if (!isSelf) {
    const targetUser = await User.findOne({ _id: req.params.userId, ...companyFilter(req) });
    if (!targetUser) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  const doc = await FaceDescriptor.findOne({ userId: req.params.userId }).select('enrolledAt');
  res.json({ enrolled: Boolean(doc), enrolledAt: doc?.enrolledAt || null });
});

router.delete('/:userId', async (req, res) => {
  const isAdmin = isHrRole(req.auth.role);
  const isSelf = req.auth.sub === req.params.userId;
  // Deleting your own template used to be self-service, which was the same
  // thing as re-enrolling without permission: delete, then enrol as if for
  // the first time. Removing a template is now an HR/Admin action.
  if (!isAdmin) {
    return res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: isSelf
          ? 'Ask HR to remove or re-verify your face template.'
          : 'Not allowed to revoke this biometric template.',
      },
    });
  }

  const targetUser = isSelf
    ? await User.findById(req.auth.sub)
    : await User.findOne({ _id: req.params.userId, ...companyFilter(req) });
  if (!targetUser) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  const deleted = await FaceDescriptor.findOneAndDelete({ userId: targetUser._id });
  if (!deleted) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No biometric template found for this user.' } });
  }

  await logAudit(req, {
    action: 'Biometric face template revoked',
    subject: targetUser.name,
    details: `Biometric template deleted for account ${targetUser.email}`,
  });

  res.json({ ok: true, id: String(targetUser._id) });
});

export default router;
