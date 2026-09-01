import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import RefreshToken from '../models/RefreshToken.js';
import FaceDescriptor from '../models/FaceDescriptor.js';
import {
  signAccessToken, generateRefreshToken, hashToken,
  refreshCookieOptions, REFRESH_TOKEN_TTL_MS, REFRESH_COOKIE_NAME,
} from '../lib/tokens.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { loginSchema, forgotPasswordSchema, resetPasswordSchema, verifyTwoFactorSchema, changePasswordSchema } from '../validations/authValidation.js';
import { sendOtpEmail } from '../lib/mailer.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import { extractDescriptor, matchDescriptor, faceFailureMessage } from '../lib/faceEngine.js';
import { imageUploadMiddleware } from '../lib/photoStorage.js';

const router = Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const faceLoginUpload = imageUploadMiddleware('photo', 'Face-login photo must be a JPEG, PNG, or WebP image.');

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

function loginActor(user) {
  return { id: String(user._id), name: user.name, role: user.role };
}

// Marks the moment a human actually completes a sign-in (password or face,
// after any 2FA step) — deliberately never called from /refresh, which is a
// silent token renewal, not a fresh login.
async function recordLogin(user, req) {
  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip;
  await user.save();
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
    await logAudit(req, {
      action: 'Sign-in blocked (account locked)', subject: user.email,
      actor: loginActor(user), company: user.company,
    });
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
    await logAudit(req, {
      action: 'Failed sign-in attempt', subject: String(email || ''), details: 'Invalid email or password',
      actor: user ? loginActor(user) : { name: 'Unknown', role: 'Unknown' }, company: user?.company || 'Smaatech',
    });
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
  await recordLogin(user, req);
  await logAudit(req, {
    action: 'User signed in', subject: user.email,
    actor: loginActor(user), company: user.company,
  });
  const accessToken = await issueSession(res, user, req);
  res.json({ accessToken, user });
});

// Face-based sign-in: the client pre-matches a live camera frame against
// locally-held enrolled descriptors purely to decide which account to
// attempt (src/components/FaceLogin.jsx, src/lib/faceAuth.js) — that's
// UX-only. The server is the actual verification authority here: it
// re-extracts and re-matches the uploaded photo against this user's
// enrolled descriptor, exactly the way attendance check-in already does
// (handlePunch in routes/attendance.js), so a forged/modified client can't
// just assert "matched: true" the way the old version of this route did.
router.post('/face-login', loginLimiter, faceLoginUpload, async (req, res) => {
  const { email } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) {
    await logAudit(req, {
      action: 'Failed face sign-in attempt', subject: String(email || ''), details: 'No account for this profile',
      actor: { name: 'Unknown', role: 'Unknown' },
    });
    return res.status(401).json({ error: { code: 'NO_SUCH_USER', message: 'No account for this profile.' } });
  }
  if (user.active === false) {
    return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
  }

  if (!req.file) {
    return res.status(400).json({ error: { code: 'NO_PHOTO', message: faceFailureMessage('NO_PHOTO') } });
  }
  const enrolled = await FaceDescriptor.findOne({ userId: user._id });
  if (!enrolled) {
    return res.status(400).json({ error: { code: 'NOT_ENROLLED', message: faceFailureMessage('NOT_ENROLLED') } });
  }
  const extraction = await extractDescriptor(req.file.buffer);
  if (extraction.error) {
    return res.status(400).json({ error: { code: extraction.error, message: faceFailureMessage(extraction.error) } });
  }
  const match = matchDescriptor(extraction.descriptor, enrolled.descriptor);
  if (!match.matched) {
    await logAudit(req, {
      action: 'Failed face sign-in attempt', subject: user.email, details: `Face did not match (confidence ${Math.round(match.confidence)})`,
      actor: loginActor(user), company: user.company,
    });
    return res.status(401).json({ error: { code: 'FACE_NOT_MATCHED', message: faceFailureMessage('FACE_NOT_MATCHED') } });
  }

  await sanitizeEmployeeLink(user);
  if (await maybeStartTwoFactor(user, res)) return;
  await recordLogin(user, req);
  await logAudit(req, {
    action: 'Face sign-in', subject: user.email, details: `Match confidence ${Math.round(match.confidence)}`,
    actor: loginActor(user), company: user.company,
  });
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
    await logAudit(req, {
      action: 'Failed 2FA attempt', subject: user.email,
      actor: loginActor(user), company: user.company,
    });
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Incorrect verification code.' } });
  }

  user.loginOtpHash = null;
  user.loginOtpExpiresAt = null;
  if (user.failedLoginAttempts || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }
  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip;
  await user.save();
  await sanitizeEmployeeLink(user);
  await logAudit(req, {
    action: 'User signed in', subject: user.email,
    actor: loginActor(user), company: user.company,
  });
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
    const record = await RefreshToken.findOneAndUpdate(
      { tokenHash: hashToken(token), revokedAt: null },
      { revokedAt: new Date() },
    );
    if (record) {
      const user = await User.findById(record.userId);
      if (user) {
        await logAudit(req, {
          action: 'User signed out', subject: user.email,
          actor: loginActor(user), company: user.company,
        });
      }
    }
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
  await logAudit(req, { action: 'Session revoked', subject: session.userAgent || String(session._id) });

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
  if (result.modifiedCount > 0) {
    await logAudit(req, { action: 'All other sessions revoked', details: `${result.modifiedCount} session(s)` });
  }
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
  await logAudit(req, { action: 'Password changed', subject: user.email });

  res.json({ ok: true });
});

// Sends a real 6-digit code to the account's actual email — replaces the
// old flow where the client just self-certified an email address with no
// verification at all. The code itself is never returned in the response;
// it only ever reaches the user via their inbox.
router.post('/forgot-password', loginLimiter, validate(forgotPasswordSchema), async (req, res) => {
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
  await logAudit(req, {
    action: 'Password reset requested', subject: user.email,
    actor: loginActor(user), company: user.company,
  });
  res.json({ ok: true });
});

// A wrong code counts toward the same failedLoginAttempts/lockedUntil
// lockout as a wrong password/2FA guess — closes the gap where an
// IP-rotating attacker could otherwise keep guessing the 6-digit code past
// what loginLimiter alone stops (mirrors /verify-2fa).
router.post('/reset-password', loginLimiter, validate(resetPasswordSchema), async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  const user = email && await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user || !user.otpHash || !user.otpExpiresAt || user.otpExpiresAt < new Date()) {
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Code expired or not requested — request a new one.' } });
  }
  const otpValid = await bcrypt.compare(String(otp || ''), user.otpHash);
  if (!otpValid) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= LOCK_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    return res.status(400).json({ error: { code: 'INVALID_OTP', message: 'Incorrect verification code.' } });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.otpHash = null;
  user.otpExpiresAt = null;
  if (user.failedLoginAttempts || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }
  await user.save();
  await logAudit(req, {
    action: 'Password reset completed', subject: user.email,
    actor: loginActor(user), company: user.company,
  });
  res.json({ ok: true });
});

export default router;

