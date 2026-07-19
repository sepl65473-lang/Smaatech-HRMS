import { Router } from 'express';
import AuditLog from '../models/AuditLog.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('HR Director'), async (req, res) => {
  try {
    const logs = await AuditLog.find(companyFilter(req)).sort({ createdAt: -1 }).limit(100);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { action, subject, details } = req.body || {};
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    const created = await AuditLog.create({
      actor: req.auth ? {
        id: req.auth.id,
        name: req.auth.name,
        role: req.auth.role,
      } : { name: 'System', role: 'System' },
      action,
      subject: subject || '',
      details: details || '',
      ip,
      userAgent,
      company: req.auth?.company || 'Smaatech',
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

export default router;
