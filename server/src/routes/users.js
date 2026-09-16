import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import RefreshToken from '../models/RefreshToken.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from '../lib/passwordPolicy.js';
import { sendWelcomeEmail } from '../lib/mailer.js';
import { terminateAllAccess } from '../lib/sessionRevoker.js';

const router = Router();
router.use(requireAuth);

// Mirrors src/lib/permissions.js's ROLES — server and client are separate
// npm packages with no shared module, so this is kept in sync manually.
const VALID_ROLES = ['HR Director', 'HR Manager', 'Finance Lead', 'Employee'];

// requireRole() with no arguments only lets the built-in HR Director
// superuser bypass through — login/user management is Director-only.
router.get('/', requireRole(), async (req, res) => {
  const rows = await User.find(companyFilter(req)).sort({ createdAt: 1 });
  // This route is already HR-Director-only, so it's safe to surface these
  // fields here even though User's shared toJSON transform strips them
  // everywhere else (e.g. /auth/me) for privacy.
  res.json(rows.map((u) => ({
    ...u.toJSON(),
    lastLoginAt: u.lastLoginAt,
    lockedUntil: u.lockedUntil,
    failedLoginAttempts: u.failedLoginAttempts,
  })));
});

// Lets an HR Director see every device/browser currently holding a live
// refresh token for SOMEONE ELSE's account — the admin counterpart to the
// self-service GET /auth/sessions (which only ever returns the caller's own).
router.get('/:id/sessions', requireRole(), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  const target = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  const sessions = await RefreshToken.find({
    userId: target._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  res.json(sessions.map((s) => ({
    id: String(s._id),
    userAgent: s.userAgent || '',
    ip: s.ip || '',
    createdAt: s.createdAt,
  })));
});

router.delete('/:id/sessions/:sessionId', requireRole(), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.sessionId)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  const target = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  const session = await RefreshToken.findOne({ _id: req.params.sessionId, userId: target._id });
  if (!session) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });

  session.revokedAt = new Date();
  await session.save();
  await logAudit(req, { action: 'Session revoked (by admin)', subject: target.name, details: session.userAgent || '' });
  res.json({ ok: true });
});

router.post('/', requireRole(), async (req, res) => {
  const { name, email, password, role, employeeId, initials } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'Name is required.' } });
  }
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Enter a valid email.' } });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: PASSWORD_POLICY_MESSAGE } });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: { code: 'INVALID_ROLE', message: 'Unrecognised role.' } });
  }

  const normEmail = String(email).toLowerCase().trim();
  if (await User.findOne({ email: normEmail })) {
    return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'A login already exists for that email.' } });
  }

  let empId = null;
  if (employeeId) {
    if (!mongoose.Types.ObjectId.isValid(employeeId) || !(await Employee.exists({ _id: employeeId, ...companyFilter(req) }))) {
      return res.status(404).json({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Linked employee record not found.' } });
    }
    empId = employeeId;
  }

  try {
    const created = await User.create({
      name: name.trim(),
      email: normEmail,
      passwordHash: await bcrypt.hash(password, 10),
      role,
      initials: initials || undefined,
      employeeId: empId,
      status: 'Active',
      mustChangePassword: true,
      company: req.auth.company,
    });

    const emailRes = await sendWelcomeEmail({
      toEmail: normEmail,
      userName: created.name,
      role: created.role,
      tempPassword: password,
      company: req.auth.company,
      userId: created._id,
    });

    if (empId) {
      await Employee.findByIdAndUpdate(empId, {
        onboardingStatus: emailRes.sent ? 'Invited' : 'Account Created',
      });
    }

    await logAudit(req, {
      action: 'Login created',
      subject: created.name,
      details: `Account Status: Active | Welcome Email: ${emailRes.sent ? 'SENT' : 'FAILED'}`,
      after: created,
    });

    res.status(201).json({
      ...created.toJSON(),
      emailStatus: emailRes.sent ? 'SENT' : 'FAILED',
      emailError: emailRes.error || null,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'A login already exists for that email.' } });
    }
    throw err;
  }
});

router.post('/:id/resend-welcome', requireRole(), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  const target = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  // crypto, not Math.random: a predictable temporary password is a takeover
  // of the account it was generated for.
  const tempPassword = req.body?.tempPassword
    || `Tmp#${crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x')}`;
  target.passwordHash = await bcrypt.hash(tempPassword, 10);
  target.mustChangePassword = true;
  await target.save();
  // Resetting the password invalidates the old one, so every session that was
  // established with it must go too.
  await terminateAllAccess(target._id, { reason: 'welcome email resent with a new temporary password' });

  const emailRes = await sendWelcomeEmail({
    toEmail: target.email,
    userName: target.name,
    role: target.role,
    tempPassword,
    company: req.auth.company,
    userId: target._id,
    idempotencyKey: `${req.auth.company}_welcome_${target.email}_${Date.now()}`,
  });

  if (target.employeeId) {
    await Employee.findByIdAndUpdate(target.employeeId, {
      onboardingStatus: emailRes.sent ? 'Invited' : 'Account Created',
    });
  }

  await logAudit(req, {
    action: 'Welcome email resent',
    subject: target.name,
    details: `Delivery Status: ${emailRes.sent ? 'SENT' : 'FAILED'}`,
  });

  res.json({
    ok: true,
    emailStatus: emailRes.sent ? 'SENT' : 'FAILED',
    emailError: emailRes.error || null,
    tempPassword,
  });
});

router.patch('/:id', requireRole(), async (req, res) => {
  const { name, role, employeeId, password, active } = req.body || {};
  const patch = {};
  if (name != null) patch.name = name.trim();
  if (role != null) {
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { code: 'INVALID_ROLE', message: 'Unrecognised role.' } });
    }
    patch.role = role;
  }
  if (employeeId !== undefined) {
    if (!employeeId) {
      patch.employeeId = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(employeeId) || !(await Employee.exists({ _id: employeeId, ...companyFilter(req) }))) {
        return res.status(404).json({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Linked employee record not found.' } });
      }
      patch.employeeId = employeeId;
    }
  }
  if (active != null) patch.active = Boolean(active);
  if (password) {
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: PASSWORD_POLICY_MESSAGE } });
    }
    patch.passwordHash = await bcrypt.hash(password, 10);
  }

  const before = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  // The last HR Director must not be able to lock everyone out of admin.
  const losingDirector = before.role === 'HR Director'
    && ((patch.role && patch.role !== 'HR Director') || patch.active === false);
  if (losingDirector) {
    const remaining = await User.countDocuments({
      _id: { $ne: before._id }, role: 'HR Director', active: true, ...companyFilter(req),
    });
    if (remaining === 0) {
      return res.status(409).json({
        error: { code: 'LAST_ADMIN', message: 'This is the last active HR Director — promote another before changing this account.' },
      });
    }
  }

  const updated = await User.findOneAndUpdate({ _id: req.params.id, ...companyFilter(req) }, patch, { new: true });

  // Any change to what this account may do must end its existing sessions.
  // Previously none of these paths touched RefreshToken or tokenVersion, so a
  // deactivated user kept a working 15-minute access token on every endpoint
  // and a valid 30-day refresh token, and a demoted user kept their old role
  // in an already-issued token.
  const accessChanged = patch.active === false
    || (patch.role && patch.role !== before.role)
    || Boolean(patch.passwordHash);
  if (accessChanged) {
    const reasons = [
      patch.active === false ? 'deactivated' : null,
      patch.role && patch.role !== before.role ? `role ${before.role} -> ${patch.role}` : null,
      patch.passwordHash ? 'password reset by admin' : null,
    ].filter(Boolean).join('; ');
    const revoked = await terminateAllAccess(updated._id, { reason: reasons });
    await logAudit(req, {
      action: 'Sessions terminated after account change',
      subject: updated.name,
      details: `${reasons} — ${revoked} session(s) revoked, outstanding access tokens invalidated.`,
    });
  }

  await logAudit(req, { action: 'Login updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole(), async (req, res) => {
  const before = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.json({ id: req.params.id });

  if (String(before._id) === String(req.auth.sub)) {
    return res.status(400).json({ error: { code: 'CANNOT_DELETE_SELF', message: 'You cannot delete the account you are signed in with.' } });
  }
  if (before.role === 'HR Director') {
    const remaining = await User.countDocuments({
      _id: { $ne: before._id }, role: 'HR Director', active: true, ...companyFilter(req),
    });
    if (remaining === 0) {
      return res.status(409).json({ error: { code: 'LAST_ADMIN', message: 'This is the last active HR Director — promote another before deleting this account.' } });
    }
  }

  // Revoke first, then delete: the refresh-token rows outlive the user row
  // and would otherwise sit there until they expired.
  await terminateAllAccess(before._id, { reason: 'login deleted' });
  await User.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  await logAudit(req, { action: 'Login removed', subject: before.name, before });
  res.json({ id: req.params.id });
});

export default router;
