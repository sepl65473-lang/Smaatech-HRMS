import { Router } from 'express';
import AuditLog from '../models/AuditLog.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Every mutating route already writes its own AuditLog entry via logAudit()
// (see server/src/lib/auditLogger.js). This endpoint exists only for the
// handful of client-only events that have no server-side mutation to hang a
// logAudit() call off of (bulk-import summaries, exports/downloads, onboarding
// notes) — anything else here would just be a spoofable duplicate of an entry
// the server already wrote.
const CLIENT_ONLY_ACTIONS = new Set([
  'Employees imported', 'Assets imported', 'Holidays imported', 'Jobs imported',
  'Attendance check-in', 'Attendance check-out', 'Biometric punch reconciled', 'Attendance override',
  'Payroll processed',
  'Candidate moved', 'Candidate added', 'Candidate removed',
  'Holiday added', 'Holiday removed',
  'Review cycle started', 'Self review submitted', 'Manager review submitted',
  'Role created', 'Role updated', 'Role deleted',
  'Master value added', 'Master value removed',
  'Employees exported', 'Biometric device synced', 'Tally export generated',
  'Bank file generated', 'Payslip downloaded',
  'Resume Downloaded', 'Document Uploaded', 'Exit Interview Filed',
]);

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
    if (!CLIENT_ONLY_ACTIONS.has(action)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Unknown action — this event should be logged server-side.' } });
    }
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
