import { Router } from 'express';
import Resignation from '../models/Resignation.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';
import { sendNotification } from '../lib/notificationService.js';

const router = Router();
router.use(requireAuth);

const CLEARANCE_DEPTS = ['IT', 'Finance', 'HR', 'Admin'];

// List resignations based on company scope and role permissions
router.get('/', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isFinance = req.auth.role === 'Finance Lead';
  
  let scope = companyFilter(req);
  if (!isHR && !isFinance) {
    // Regular employees can only see their own resignation
    if (req.auth.employeeId) {
      scope.employeeId = req.auth.employeeId;
    } else {
      return res.json([]);
    }
  }

  const rows = await Resignation.find(scope).sort({ createdAt: -1 });
  res.json(rows);
});

// Submit a new resignation
router.post('/', async (req, res) => {
  const { employeeId, employeeName, resignationDate, requestedLastWorkingDay, reason } = req.body || {};
  
  // Regular employees can only submit resignation for themselves
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR && String(employeeId) !== String(req.auth.employeeId)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only file resignation for yourself.' } });
  }

  // Pre-load default clearances list
  const clearances = CLEARANCE_DEPTS.map(dept => ({
    dept,
    status: 'Pending',
    approvedBy: '',
    approvedAt: '',
    notes: ''
  }));

  const created = await Resignation.create({
    employeeId,
    employeeName,
    resignationDate,
    requestedLastWorkingDay,
    reason,
    clearances,
    company: req.auth.company
  });

  await logAudit(req, { action: 'Resignation filed', subject: employeeName, after: created });

  // Notify HR Managers of the resignation
  try {
    const hrManagers = await User.find({ role: 'HR Manager', company: req.auth.company });
    for (const hr of hrManagers) {
      await sendNotification({
        recipientId: hr._id,
        title: 'New Resignation Filed',
        message: `${employeeName} has submitted resignation. Last working day requested: ${requestedLastWorkingDay}.`,
        type: 'system',
        actionUrl: '/resignations',
        channels: ['in-app', 'email'],
        company: req.auth.company
      });
    }
  } catch (err) {
    console.error('Failed to send resignation alerts:', err);
  }

  res.status(201).json(created);
});

// Sign-off on clearance check
router.post('/:id/clearance', async (req, res) => {
  const { dept, status, notes } = req.body || {};
  
  if (!CLEARANCE_DEPTS.includes(dept)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid clearance department.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  // Permission checks
  const isIT = req.auth.role === 'IT Support' || ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isFinance = req.auth.role === 'Finance Lead' || ['HR Director', 'HR Manager'].includes(req.auth.role);
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);

  if (dept === 'IT' && !isIT) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only IT/HR can sign off IT clearance.' } });
  if (dept === 'Finance' && !isFinance) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance/HR can sign off Finance clearance.' } });
  if ((dept === 'HR' || dept === 'Admin') && !isHR) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR can sign off HR/Admin clearances.' } });

  const before = JSON.parse(JSON.stringify(resignation));
  
  // Update target clearance record
  resignation.clearances = resignation.clearances.map(c => {
    if (c.dept === dept) {
      return {
        dept,
        status,
        notes: notes || '',
        approvedBy: req.auth.name || req.auth.role,
        approvedAt: new Date().toISOString().slice(0, 10)
      };
    }
    return c;
  });

  await resignation.save();
  await logAudit(req, { action: `Clearance signed off (${dept})`, subject: resignation.employeeName, before, after: resignation });

  res.json(resignation);
});

// Process/Draft Full & Final (FnF) Settlement calculations
router.post('/:id/fnf', async (req, res) => {
  const isFinance = req.auth.role === 'Finance Lead' || req.auth.role === 'HR Director';
  if (!isFinance) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance Lead or HR Director can calculate FnF.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  const before = JSON.parse(JSON.stringify(resignation));
  const data = req.body || {};

  const monthlySalary = Number(data.monthlySalary) || 0;
  const leaveEncashment = Number(data.leaveEncashment) || 0;
  const gratuity = Number(data.gratuity) || 0;
  const otherAllowances = Number(data.otherAllowances) || 0;
  const loansDeduction = Number(data.loansDeduction) || 0;
  const assetDeduction = Number(data.assetDeduction) || 0;
  const otherDeductions = Number(data.otherDeductions) || 0;

  const netPayout = (monthlySalary + leaveEncashment + gratuity + otherAllowances) - (loansDeduction + assetDeduction + otherDeductions);

  resignation.fnfSettlement = {
    monthlySalary,
    leaveEncashment,
    gratuity,
    otherAllowances,
    loansDeduction,
    assetDeduction,
    otherDeductions,
    netPayout,
    status: 'Processed',
    processedAt: new Date().toISOString().slice(0, 10),
    notes: data.notes || ''
  };

  await resignation.save();
  await logAudit(req, { action: 'FnF Settlement Processed', subject: resignation.employeeName, before, after: resignation });

  res.json(resignation);
});

// Pay Full & Final (FnF) Settlement and terminate employee status
router.post('/:id/fnf/pay', async (req, res) => {
  const isFinance = req.auth.role === 'Finance Lead' || req.auth.role === 'HR Director';
  if (!isFinance) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only Finance Lead or HR Director can pay FnF.' } });
  }

  const resignation = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!resignation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  const before = JSON.parse(JSON.stringify(resignation));

  resignation.fnfSettlement.status = 'Paid';
  resignation.status = 'Approved';
  if (!resignation.approvedLastWorkingDay) {
    resignation.approvedLastWorkingDay = resignation.requestedLastWorkingDay;
  }
  await resignation.save();

  // Lifecycle automation: mark employee as exited, and disable credentials
  await Employee.findByIdAndUpdate(resignation.employeeId, { status: 'exited' });
  await User.findOneAndUpdate({ employeeId: resignation.employeeId }, { active: false });

  await logAudit(req, { action: 'FnF Paid & Employee Terminated', subject: resignation.employeeName, before, after: resignation });

  // Notify employee of payment finalization
  try {
    const user = await User.findOne({ employeeId: resignation.employeeId });
    if (user) {
      await sendNotification({
        recipientId: user._id,
        title: 'FnF Payout Processed',
        message: `Your Full & Final Settlement has been processed and paid out. Net Payout: ₹${resignation.fnfSettlement.netPayout}.`,
        type: 'system',
        actionUrl: '/resignations',
        channels: ['in-app', 'email'],
        company: resignation.company
      });
    }
  } catch (err) {
    console.error('Failed to notify employee of FnF pay:', err);
  }

  res.json(resignation);
});

// General update endpoint ( LWD updates or approve/reject status changes )
router.patch('/:id', async (req, res) => {
  const isHR = ['HR Director', 'HR Manager'].includes(req.auth.role);
  if (!isHR) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR personnel can modify resignation terms.' } });
  }

  const before = await Resignation.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resignation record not found.' } });
  }

  const updated = await Resignation.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  await logAudit(req, { action: 'Resignation updated', subject: updated.employeeName, before, after: updated });

  // If approved LWD, let employee know
  if (req.body.approvedLastWorkingDay && req.body.approvedLastWorkingDay !== before.approvedLastWorkingDay) {
    try {
      const user = await User.findOne({ employeeId: updated.employeeId });
      if (user) {
        await sendNotification({
          recipientId: user._id,
          title: 'Resignation Terms Updated',
          message: `Your approved last working day has been set to ${req.body.approvedLastWorkingDay}.`,
          type: 'system',
          actionUrl: '/resignations',
          channels: ['in-app'],
          company: updated.company
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  res.json(updated);
});

export default router;
