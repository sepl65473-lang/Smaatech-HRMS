import { Router } from 'express';
import Role from '../models/Role.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  const rows = await Role.find().sort({ createdAt: 1 });
  res.json(rows);
});

router.post('/', requireRole('HR Director'), async (req, res) => {
  try {
    const created = await Role.create(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.patch('/:id', requireRole('HR Director'), async (req, res) => {
  try {
    const updated = await Role.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Role not found.' } });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.delete('/:id', requireRole('HR Director'), async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Role not found.' } });
    
    const defaultRoles = ['HR Director', 'HR Manager', 'Finance Lead', 'Employee'];
    if (defaultRoles.includes(role.name)) {
      return res.status(400).json({ error: { code: 'PROTECTED_ROLE', message: 'System default roles cannot be deleted.' } });
    }
    
    await Role.findByIdAndDelete(req.params.id);
    res.json({ id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

export default router;
