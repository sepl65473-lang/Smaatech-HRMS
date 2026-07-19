import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import RefreshToken from '../models/RefreshToken.js';
import {
  signAccessToken, generateRefreshToken, hashToken,
  refreshCookieOptions, REFRESH_TOKEN_TTL_MS, REFRESH_COOKIE_NAME,
} from '../lib/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../validations/authValidation.js';
import { sendOtpEmail } from '../lib/mailer.js';

const router = Router();
const OTP_TTL_MS = 10 * 60 * 1000;

// Guards against a dangling employeeId (e.g. a demo/data reseed deleted the
// employee a user account was linked to) so a login/refresh/me response
// never hands the client a reference to an employee that no longer exists.
async function sanitizeEmployeeLink(user) {
  if (!user.employeeId) return user;
  const exists = await Employee.exists({ _id: user.employeeId });
  if (!exists) {
    user.employeeId = null;
    await user.save();
  }
  return user;
}

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

router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  const valid = user && await bcrypt.compare(password || '', user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
  }
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  await sanitizeEmployeeLink(user);
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
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  await sanitizeEmployeeLink(user);
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
  if (user.active === false) {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  await sanitizeEmployeeLink(user);

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
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  await sanitizeEmployeeLink(user);
  res.json({ user });
});

// Sends a real 6-digit code to the account's actual email — replaces the
// old flow where the client just self-certified an email address with no
// verification at all. The code itself is never returned in the response;
// it only ever reaches the user via their inbox.
router.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const { email } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  // Same response whether or not the account exists, so this can't be used
  // to enumerate registered emails.
  if (!user) return res.json({ ok: true });
  if (user.role === 'HR Director') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin password can only be changed from Settings after signing in.' } });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  user.otpHash = await bcrypt.hash(otp, 10);
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  await user.save();

  try {
    await sendOtpEmail(user.email, otp, 'password reset');
  } catch (err) {
    console.error('[auth] failed to send OTP email:', err.message);
    return res.status(502).json({ error: { code: 'EMAIL_FAILED', message: 'Could not send the verification email. Try again shortly.' } });
  }
  res.json({ ok: true });
});

router.post('/reset-password', validate(resetPasswordSchema), async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user || !user.otpHash || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Code expired or not requested — request a new one.' } });
  }
  const otpValid = await bcrypt.compare(String(otp || ''), user.otpHash);
  if (!otpValid) {
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Incorrect verification code.' } });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.otpHash = null;
  user.otpExpiresAt = null;
  await user.save();
  res.json({ ok: true });
});

export default router;

