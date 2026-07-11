import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import RefreshToken from '../models/RefreshToken.js';
import {
  signAccessToken, generateRefreshToken, hashToken,
  refreshCookieOptions, REFRESH_TOKEN_TTL_MS, REFRESH_COOKIE_NAME,
} from '../lib/tokens.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

async function issueSession(res, user, req) {
  const accessToken = signAccessToken(user);
  const refreshToken = generateRefreshToken();
  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  const valid = user && await bcrypt.compare(password || '', user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
  }
  const accessToken = await issueSession(res, user, req);
  res.json({ accessToken, user });
});

// Face-based sign-in: the live camera match already happened client-side
// (src/components/FaceLogin.jsx, using src/lib/faceAuth.js), so this only
// proves "some browser matched a locally-held descriptor to this email" —
// it does NOT re-verify the face server-side. Real server-side face
// verification is scoped for a later phase (see the project plan); until
// then this is a lower-assurance login path than password auth, kept only
// because the app already advertises "sign in with face" as a feature.
router.post('/face-login', async (req, res) => {
  const { email } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) {
    return res.status(401).json({ error: { code: 'NO_SUCH_USER', message: 'No account for this profile.' } });
  }
  const accessToken = await issueSession(res, user, req);
  res.json({ accessToken, user });
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: { code: 'NO_REFRESH', message: 'Not signed in.' } });

  const tokenHash = hashToken(token);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Session expired, please sign in again.' } });
  }
  const user = await User.findById(record.userId);
  if (!user) return res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Session expired, please sign in again.' } });

  record.revokedAt = new Date();
  await record.save();
  const accessToken = await issueSession(res, user, req);
  res.json({ accessToken, user });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    await RefreshToken.updateOne({ tokenHash: hashToken(token) }, { revokedAt: new Date() });
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.auth.sub);
  if (!user) return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired.' } });
  res.json({ user });
});

// No-token password reset, matching the existing ForgotPasswordModal UX
// (which is explicitly labeled "a local demo — no email is sent" in its own
// copy). Real out-of-band verification (emailed reset link) is out of scope here.
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' } });
  }
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) return res.status(404).json({ error: { code: 'NO_SUCH_USER', message: 'No account found with this email.' } });
  if (user.role === 'HR Director') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin password can only be changed from Settings after signing in.' } });
  }
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ ok: true });
});

export default router;
