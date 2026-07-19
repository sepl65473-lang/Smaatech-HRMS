import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

// Mirrors src/lib/permissions.js's ROLES — server and client are separate
// npm packages with no shared module, so this is kept in sync manually.
const VALID_ROLES = ['HR Director', 'HR Manager', 'Finance Lead', 'Employee'];

// requireRole() with no arguments only lets the built-in HR Director
// superuser bypass through — login/user management is Director-only.
router.get('/', requireRole(), async (req, res) => {
  const rows = await User.find(companyFilter(req)).sort({ createdAt: 1 });
  res.json(rows);
});

router.post('/', requireRole(), async (req, res) => {
  const { name, email, password, role, employeeId, initials } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ error: { code: 'NAME_REQUIRED', message: 'Name is required.' } });
  }
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: { code: 'INVALID_EMAIL', message: 'Enter a valid email.' } });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' } });
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
    if (!mongoose.Types.ObjectId.isValid(employeeId) || !(await Employee.exists({ _id: employeeId }))) {
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
      if (!mongoose.Types.ObjectId.isValid(employeeId) || !(await Employee.exists({ _id: employeeId }))) {
        return res.status(404).json({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Linked employee record not found.' } });
      }
      patch.employeeId = employeeId;
    }
  }
  if (active != null) patch.active = Boolean(active);
  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 6 characters.' } });
    }
    patch.passwordHash = await bcrypt.hash(password, 10);
  }

  const before = await User.findById(req.params.id);
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  const updated = await User.findByIdAndUpdate(req.params.id, patch, { new: true });
  await logAudit(req, { action: 'Login updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole(), async (req, res) => {
  const before = await User.findById(req.params.id);
  if (before) {
    await User.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Login removed', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
