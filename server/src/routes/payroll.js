import { Router } from 'express';
import Payroll from '../models/Payroll.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

import { logAudit } from '../lib/auditLogger.js';
import User from '../models/User.js';
import { sendNotification, resolveChannels, fillTemplate } from '../lib/notificationService.js';
import { getSettingsDoc } from './settings.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const canSeeAll = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const scope = { ...companyFilter(req), ...(canSeeAll ? {} : { empId: req.auth.employeeId }) };
  const rows = await Payroll.find(scope).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const canSeeAll = ['HR Director', 'HR Manager', 'Finance Lead'].includes(req.auth.role);
  const scope = { _id: req.params.id, ...companyFilter(req), ...(canSeeAll ? {} : { empId: req.auth.employeeId }) };
  const row = await Payroll.findOne(scope);
  res.json(row || null);
});

// HR Manager needs this too — addEmployee/updateEmployee/deleteEmployee (all
// gated to HR Manager on /employees) cascade payroll row create/patch/delete
// for denormalization sync, alongside Finance Lead's own process/pay actions.
router.post('/', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const body = { ...(req.body || {}), company: req.auth.company };
  const created = await Payroll.create(body);
  await logAudit(req, { action: 'Payroll processed', subject: created.name, after: created });

  // Notify target employee
  if (created.status === 'ready') {
    try {
      const recipientUser = await User.findOne({ employeeId: created.empId });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: 'Payslip Ready',
          message: `Your payslip for cycle ${created.cycle} has been processed and is ready.`,
          type: 'payroll',
          actionUrl: '/payroll',
          channels: resolveChannels(settingsDoc, 'payroll'),
          emailOverride: fillTemplate(settingsDoc.notificationTemplates?.email?.payrollSlip, {
            employee: created.name,
            date: created.cycle,
          }),
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending payroll processed notification:', err);
    }
  }

  res.status(201).json(created);
});

router.patch('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Payroll.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payroll record not found.' } });

  const updated = await Payroll.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  
  // Check transitions
  const isProcessed = before.status !== 'ready' && updated.status === 'ready';
  const isPaid = before.status !== 'paid' && updated.status === 'paid';
  
  if (isProcessed || isPaid) {
    try {
      const recipientUser = await User.findOne({ employeeId: updated.empId });
      if (recipientUser) {
        const settingsDoc = await getSettingsDoc(req.auth.company);
        await sendNotification({
          recipientId: recipientUser._id,
          title: isPaid ? 'Salary Disbursed' : 'Payslip Ready',
          message: isPaid
            ? `Your salary for cycle ${updated.cycle} has been disbursed.`
            : `Your payslip for cycle ${updated.cycle} has been processed and is ready.`,
          type: 'payroll',
          actionUrl: '/payroll',
          channels: resolveChannels(settingsDoc, 'payroll'),
          emailOverride: isProcessed
            ? fillTemplate(settingsDoc.notificationTemplates?.email?.payrollSlip, {
                employee: updated.name,
                date: updated.cycle,
              })
            : null,
          company: req.auth.company,
        });
      }
    } catch (err) {
      console.error('Error sending payroll patch notification:', err);
    }
  }

  const isMarkedPaid = before.status !== 'paid' && updated.status === 'paid';
  const actionName = isMarkedPaid ? 'Payslip marked paid' : 'Salary structure updated';
  await logAudit(req, { action: actionName, subject: updated.name, before, after: updated });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager', 'Finance Lead'), async (req, res) => {
  const before = await Payroll.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (before) {
    await Payroll.findByIdAndDelete(req.params.id);
    await logAudit(req, { action: 'Payroll record removed', subject: before.name, before });
  }
  res.json({ id: req.params.id });
});

export default router;
