import { Router } from 'express';
import Employee from '../models/Employee.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

const SORT_MAP = {
  name: { name: 1 },
  dept: { dept: 1, name: 1 },
  salary: { salary: -1 },
  rating: { rating: -1 },
  newest: { joinDate: -1 },
};

router.get('/', async (req, res) => {
  const { page, limit, search, dept, sort } = req.query;

  // Legacy callers (loadAll()'s initial hydrate, and every dropdown/lookup
  // that needs the full roster — manager pickers, Attendance/Leave/Payroll
  // name joins, OrgChart, Analytics) get the same unpaginated array as
  // before. Only opt into paging/filtering when explicitly asked for it —
  // used today by the People Directory table's own search/pagination.
  if (!page && !limit) {
    const rows = await Employee.find(companyFilter(req)).sort({ createdAt: 1 });
    return res.json(rows);
  }

  const filter = { ...companyFilter(req) };
  if (dept && dept !== 'All') filter.dept = dept;
  if (search) {
    const re = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { role: re }, { dept: re }, { loc: re }];
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const [rows, total] = await Promise.all([
    Employee.find(filter).sort(SORT_MAP[sort] || SORT_MAP.name).skip((pageNum - 1) * limitNum).limit(limitNum),
    Employee.countDocuments(filter),
  ]);
  res.json({ rows, total, page: pageNum, limit: limitNum });
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

