import { Router } from 'express';
import Leave from '../models/Leave.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { getSettingsDoc } from './settings.js';
import { logAudit } from '../lib/auditLogger.js';
import User from '../models/User.js';
import { sendNotification } from '../lib/notificationService.js';

// Falls back to this sequence when HR hasn't configured Settings > Workflows
// yet — matches the default the Workflows page itself shows unconfigured.
const DEFAULT_STAGES = ['HR Manager', 'HR Director'];

function stagesFor(leave) {
  return leave.approvalStages?.length ? leave.approvalStages : DEFAULT_STAGES;
}

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const scope = { ...companyFilter(req), ...(isManager ? {} : { empId: req.auth.employeeId }) };
  const rows = await Leave.find(scope).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Leave.findById(req.params.id);
  res.json(row || null);
});

// Any authenticated user may file their own leave request (see MyDashboard's
// employee self-service flow); only HR Manager/Director can file on behalf
// of someone else. Self-service requests are always created 'pending' —
// `status` is never taken from the request body, so an employee can't
// submit an already-'approved' request for themselves.
router.post('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const { empId, name, dept, type, start, end, reason } = req.body || {};
  if (!isManager && empId !== req.auth.employeeId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file leave for yourself.' } });
  }
  const settingsDoc = await getSettingsDoc(req.auth.company);
  const created = await Leave.create({
    empId, name, dept, type, start, end, reason,
    company: req.auth.company,
    approvalStages: settingsDoc.approvalWorkflows?.leave?.length ? settingsDoc.approvalWorkflows.leave : DEFAULT_STAGES,
    currentStage: 0,
    ...(isManager ? { status: req.body?.status } : {}),
  });
  await logAudit(req, { action: 'Leave requested', subject: created.name, after: created });

  // Notify HR Managers
  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'New Leave Request',
        message: `${created.name} (${created.dept}) has filed a ${created.type} leave request from ${created.start} to ${created.end}.`,
        type: 'leave',
        actionUrl: '/leave',
        channels: ['in-app', 'email', 'sms', 'whatsapp', 'push'],
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave requested notifications:', err);
  }

  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Leave.findById(req.params.id);
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });

  const updated = await Leave.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  await logAudit(req, { action: 'Leave updated', subject: updated.name, before, after: updated });
  res.json(updated);
});

// Stage-aware approve/decline — the caller must hold the role the request's
// current stage requires (HR Director always may, as the app-wide superuser).
// Approving the last stage is what actually flips status to 'approved';
// approving an earlier one just advances currentStage and stays 'pending'.
router.post('/:id/approve', async (req, res) => {
  const leave = await Leave.findById(req.params.id);
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }
  const stages = stagesFor(leave);
  const requiredRole = stages[leave.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = leave.toObject ? leave.toObject() : JSON.parse(JSON.stringify(leave));
  leave.approvals.push({ role: req.auth.role, decision: 'approved' });
  leave.currentStage += 1;
  if (leave.currentStage >= stages.length) leave.status = 'approved';
  await leave.save();

  await logAudit(req, { 
    action: `Leave ${leave.status === 'approved' ? 'approved' : 'stage approved'}`, 
    subject: leave.name, 
    before, 
    after: leave 
  });

  // Notify Employee on final approval
  if (leave.status === 'approved') {
    try {
      const recipientUser = await User.findOne({ employeeId: leave.empId });
      if (recipientUser) {
        await sendNotification({
          recipientId: recipientUser._id,
          title: 'Leave Request Approved',
          message: `Your ${leave.type} leave request from ${leave.start} to ${leave.end} has been approved.`,
          type: 'leave',
          actionUrl: '/leave',
          channels: ['in-app', 'email', 'sms', 'whatsapp', 'push'],
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending leave approved notification:', err);
    }
  }

  res.json(leave);
});

router.post('/:id/decline', async (req, res) => {
  const leave = await Leave.findById(req.params.id);
  if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
  if (leave.status !== 'pending') {
    return res.status(400).json({ error: { code: 'ALREADY_DECIDED', message: 'This request has already been decided.' } });
  }
  const stages = stagesFor(leave);
  const requiredRole = stages[leave.currentStage] || stages[stages.length - 1];
  if (req.auth.role !== 'HR Director' && req.auth.role !== requiredRole) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: `This stage needs ${requiredRole} approval.` } });
  }
  
  const before = leave.toObject ? leave.toObject() : JSON.parse(JSON.stringify(leave));
  leave.approvals.push({ role: req.auth.role, decision: 'declined' });
  leave.status = 'declined';
  await leave.save();

  await logAudit(req, { action: 'Leave declined', subject: leave.name, before, after: leave });

  // Notify Employee on decline
  try {
    const recipientUser = await User.findOne({ employeeId: leave.empId });
    if (recipientUser) {
      await sendNotification({
        recipientId: recipientUser._id,
        title: 'Leave Request Declined',
        message: `Your ${leave.type} leave request from ${leave.start} to ${leave.end} has been declined.`,
        type: 'leave',
        actionUrl: '/leave',
        channels: ['in-app', 'email', 'sms', 'whatsapp', 'push'],
        company: req.auth.company,
      });
    }
  } catch (err) {
    console.error('Error sending leave declined notification:', err);
  }

  res.json(leave);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const before = await Leave.findById(req.params.id);
  if (before) {
    await Leave.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Leave deleted', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
