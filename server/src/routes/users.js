import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import RefreshToken from '../models/RefreshToken.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from '../lib/passwordPolicy.js';

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
      company: req.auth.company,
    });
    await logAudit(req, { action: 'Login created', subject: created.name, after: created });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'A login already exists for that email.' } });
    }
    throw err;
  }
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

  const updated = await User.findByIdAndUpdate(req.params.id, patch, { new: true });
  await logAudit(req, { action: 'Login updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole(), async (req, res) => {
  const before = await User.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await User.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Login removed', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
