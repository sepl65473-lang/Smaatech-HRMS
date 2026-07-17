import { Router } from 'express';
import Leave from '../models/Leave.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSettingsDoc } from './settings.js';

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
  const rows = await Leave.find(isManager ? {} : { empId: req.auth.employeeId }).sort({ createdAt: -1 });
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
  const settingsDoc = await getSettingsDoc();
  const created = await Leave.create({
    empId, name, dept, type, start, end, reason,
    approvalStages: settingsDoc.approvalWorkflows?.leave?.length ? settingsDoc.approvalWorkflows.leave : DEFAULT_STAGES,
    currentStage: 0,
    ...(isManager ? { status: req.body?.status } : {}),
  });
  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Leave.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found.' } });
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
  leave.approvals.push({ role: req.auth.role, decision: 'approved' });
  leave.currentStage += 1;
  if (leave.currentStage >= stages.length) leave.status = 'approved';
  await leave.save();
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
  leave.approvals.push({ role: req.auth.role, decision: 'declined' });
  leave.status = 'declined';
  await leave.save();
  res.json(leave);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Leave.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
