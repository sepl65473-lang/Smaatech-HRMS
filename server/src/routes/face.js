import { Router } from 'express';
import User from '../models/User.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { extractDescriptor, faceFailureMessage } from '../lib/faceEngine.js';
import { savePhoto, imageUploadMiddleware } from '../lib/photoStorage.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
const upload = imageUploadMiddleware('photo', 'Enrollment photo must be a JPEG, PNG, or WebP image.');

router.use(requireAuth);

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

  const result = await extractDescriptor(req.file.buffer);
  if (result.error) {
    return res.status(400).json({ error: { code: result.error, message: faceFailureMessage(result.error) } });
  }

  const photoRef = savePhoto('enrollment', `${targetUserId}.jpg`, req.file.buffer);
  await FaceDescriptor.findOneAndUpdate(
    { userId: targetUserId },
    { descriptor: result.descriptor, photoRef, enrolledAt: new Date() },
    { upsert: true },
  );

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
  const isAdmin = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const isSelf = req.auth.sub === req.params.userId;
  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed to revoke this biometric template.' } });
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
