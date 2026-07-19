import { Router } from 'express';
import Employee from '../models/Employee.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const rows = await Employee.find(companyFilter(req)).sort({ createdAt: 1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };
  try {
    const created = await Employee.create(body);
    await logAudit(req, { action: 'Employee added', subject: created.name, after: created });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'Another employee already has that email.' } });
    }
    throw err;
  }
});

const RESTRICTED_FIELDS = ['salary', 'role', 'dept', 'loc', 'status', 'managerId', 'joinDate', 'rating', 'employmentType', 'company', 'email'];

router.patch('/:id', async (req, res) => {
  const isSelf = req.auth.employeeId && String(req.auth.employeeId) === String(req.params.id);
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);

  if (!isHR && !isSelf) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to modify this profile.' } });
  }

  const before = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  let patchBody = { ...(req.body || {}) };
  if (!isHR) {
    // Sanitize body for self-service updates to protect official fields
    RESTRICTED_FIELDS.forEach((field) => {
      delete patchBody[field];
    });
  }

  try {
    const updated = await Employee.findByIdAndUpdate(req.params.id, patchBody, { new: true });
    await logAudit(req, { action: 'Employee updated', subject: updated.name, before, after: updated });
    res.json(updated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'Another employee already has that email.' } });
    }
    throw err;
  }
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Employee.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await Employee.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Employee removed', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;

