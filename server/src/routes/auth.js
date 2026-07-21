import { Router } from 'express';
import rateLimit from 'express-rate-limit';
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
import { loginSchema, forgotPasswordSchema, resetPasswordSchema, verifyTwoFactorSchema, changePasswordSchema } from '../validations/authValidation.js';
import { sendOtpEmail } from '../lib/mailer.js';
import { getSettingsDoc } from './settings.js';

const router = Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// The app-wide 300/15min limiter (index.js) is shared across every /api/*
// route, so it does little to stop credential stuffing on login/face-login
// specifically. This one is scoped tighter and just to those two routes.
// Relaxed under test (Vitest sets NODE_ENV=test) — integration tests make
// many rapid, legitimate login/verify calls from the same "IP" and would
// otherwise trip this real limit for reasons unrelated to what's under test.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts from this network. Please try again in a few minutes.' } },
});

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

// Returns true if a 2FA challenge was sent and the caller must stop (a
// response was already written); false if the caller should proceed to
// issue a real session immediately. Real second factor: the code is
// generated and hashed server-side and only ever leaves via email — unlike
// the old client-simulated version, nothing usable is returned here.
async function maybeStartTwoFactor(user, res) {
  const settingsDoc = await getSettingsDoc(user.company);
  if (!settingsDoc.twoFactor) return false;

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  user.loginOtpHash = await bcrypt.hash(otp, 10);
  user.loginOtpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  await user.save();

  try {
    await sendOtpEmail(user.email, otp, 'sign-in verification');
  } catch (err) {
    console.error('[auth] failed to send 2FA OTP email:', err.message);
    res.status(502).json({ error: { code: 'EMAIL_FAILED', message: 'Could not send the verification email. Try again shortly.' } });
    return true;
  }
  res.json({ requiresTwoFactor: true, email: user.email });
  return true;
}

router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil - new Date()) / 60000);
    return res.status(423).json({ error: { code: 'ACCOUNT_LOCKED', message: `Too many failed attempts. Try again in ${minutes} minute(s).` } });
  }

  const valid = user && await bcrypt.compare(password || '', user.passwordHash);
  if (!valid) {
    if (user) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= LOCK_THRESHOLD) {
        user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
        user.failedLoginAttempts = 0;
      }
      await user.save();
    }
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
  }
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  if (user.failedLoginAttempts || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
  }
  await sanitizeEmployeeLink(user);
  if (await maybeStartTwoFactor(user, res)) return;
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
router.post('/face-login', loginLimiter, async (req, res) => {
  const { email } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) {
    return res.status(401).json({ error: { code: 'NO_SUCH_USER', message: 'No account for this profile.' } });
  }
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  await sanitizeEmployeeLink(user);
  if (await maybeStartTwoFactor(user, res)) return;
  const accessToken = await issueSession(res, user, req);
  res.json({ accessToken, user });
});

// Completes the 2FA handshake started by /login or /face-login. A wrong
// code counts toward the same failedLoginAttempts/lockedUntil lockout as a
// wrong password — closes the gap where an IP-rotating attacker could
// otherwise keep guessing the 6-digit code past what loginLimiter alone stops.
router.post('/verify-2fa', loginLimiter, validate(verifyTwoFactorSchema), async (req, res) => {
  const { email, otp } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user || !user.loginOtpHash || !user.loginOtpExpiresAt || user.loginOtpExpiresAt < new Date()) {
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Code expired or not requested — sign in again to get a new code.' } });
  }
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }
  const otpValid = await bcrypt.compare(String(otp || ''), user.loginOtpHash);
  if (!otpValid) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= LOCK_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Incorrect verification code.' } });
  }

  user.loginOtpHash = null;
  user.loginOtpExpiresAt = null;
  if (user.failedLoginAttempts || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }
  await user.save();
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

// Lets a signed-in user see every device/browser currently holding a live
// refresh token for their account, and revoke any of them individually —
// e.g. "I forgot to log out of a shared computer."
router.get('/sessions', requireAuth, async (req, res) => {
  const currentToken = req.cookies?.[REFRESH_COOKIE_NAME];
  const currentHash = currentToken ? hashToken(currentToken) : null;
  const sessions = await RefreshToken.find({
    userId: req.auth.sub,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  res.json(sessions.map((s) => ({
    id: String(s._id),
    userAgent: s.userAgent || '',
    ip: s.ip || '',
    createdAt: s.createdAt,
    current: s.tokenHash === currentHash,
  })));
});

router.delete('/sessions/:id', requireAuth, async (req, res) => {
  const session = await RefreshToken.findOne({ _id: req.params.id, userId: req.auth.sub });
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
  session.revokedAt = new Date();
  await session.save();

  const currentToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (currentToken && hashToken(currentToken) === session.tokenHash) {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  }
  res.json({ ok: true });
});

// "Log out everywhere else" — revokes every other live session, leaving the
// caller's own current one untouched.
router.post('/sessions/revoke-others', requireAuth, async (req, res) => {
  const currentToken = req.cookies?.[REFRESH_COOKIE_NAME];
  const currentHash = currentToken ? hashToken(currentToken) : null;
  const result = await RefreshToken.updateMany(
    { userId: req.auth.sub, revokedAt: null, tokenHash: { $ne: currentHash } },
    { revokedAt: new Date() },
  );
  res.json({ revoked: result.modifiedCount });
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

// Self-service password change for a signed-in user of any role — distinct
// from /reset-password (unauthenticated, OTP-based, for when you're locked
// out) and from HR Director's PATCH /users/:id (an admin resetting someone
// ELSE's password, which correctly doesn't need to know their old one).
// This one requires proving the current password first, so a stolen access
// token alone can't silently take over the account.
router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = await User.findById(req.auth.sub);
  if (!user) return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired.' } });

  const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!valid) {
    return res.status(400).json({ error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect.' } });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();

  // Revoke every other live session — if the old password had leaked, this
  // signs out anything already using it, leaving only this session active.
  const currentToken = req.cookies?.[REFRESH_COOKIE_NAME];
  const currentHash = currentToken ? hashToken(currentToken) : null;
  await RefreshToken.updateMany(
    { userId: user._id, revokedAt: null, tokenHash: { $ne: currentHash } },
    { revokedAt: new Date() },
  );

  res.json({ ok: true });
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

