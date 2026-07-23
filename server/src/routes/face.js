import { Router } from 'express';
import multer from 'multer';
import User from '../models/User.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { extractDescriptor } from '../lib/faceEngine.js';
import { savePhoto, wrapUpload } from '../lib/photoStorage.js';

const router = Router();
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = wrapUpload(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) return cb(new Error('Enrollment photo must be a JPEG, PNG, or WebP image.'));
    cb(null, true);
  },
}).single('photo'));

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
  if (result.error === 'NO_FACE') {
    return res.status(400).json({ error: { code: 'NO_FACE', message: 'No face detected in the photo — try again with better lighting, facing the camera directly.' } });
  }
  if (result.error === 'MULTIPLE_FACES') {
    return res.status(400).json({ error: { code: 'MULTIPLE_FACES', message: 'More than one face detected — make sure only you are in frame.' } });
  }

  const photoRef = savePhoto('enrollment', `${targetUserId}.jpg`, req.file.buffer);
  await FaceDescriptor.findOneAndUpdate(
    { userId: targetUserId },
    { descriptor: result.descriptor, photoRef, enrolledAt: new Date() },
    { upsert: true },
  );

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

export default router;
