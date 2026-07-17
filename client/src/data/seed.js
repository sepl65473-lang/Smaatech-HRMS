import { DEPARTMENTS } from '../lib/helpers';

// ─────────────────────────────────────────────────────────────
//  Seed dataset — used the first time the app runs (or after reset)
//
//  Employees, Attendance, Leave, Payroll, Celebrations, Holidays,
//  Recruitment, Reviews, Expenses, Assets, and Jobs all now live on the
//  real backend (server/, see src/data/store.js) — this file only builds
//  the local-only `settings` object, still linked to the server's employee
//  roster for the `designations` default.
// ─────────────────────────────────────────────────────────────

export function buildSeed(employees) {
  const settings = {
    orgName: 'Smaatech',
    workWeek: '5-day',
    notifyLeave: true,
    notifyPayroll: true,
    notifyBirthday: false,
    twoFactor: true,
    wishesSent: 0,
    totalLeaveDays: 24,
    departments: [...DEPARTMENTS],
    designations: [...new Set(employees.map((e) => e.role))],
    // Gateway Credentials defaults
    gatewayTwilioSid: '',
    gatewayTwilioToken: '',
    gatewayTwilioFrom: '',
    gatewaySendgridKey: '',
    gatewaySmtpHost: '',
    gatewaySmtpUser: '',
    gatewaySmtpPass: '',
    // Dynamic Notification Templates
    notificationTemplates: {
      email: {
        leaveApproval: 'Subject: Leave Approval Notification\n\nDear {employee},\n\nWe are pleased to inform you that your leave request for the period {date} has been approved.\n\nBest regards,\nPeople Operations Team',
        payrollSlip: 'Subject: Monthly Salary Slip Published\n\nDear {employee},\n\nYour salary slip for {date} is now available in your ESS dashboard portal.\n\nBest regards,\nFinance Team'
      },
      sms: {
        leaveApproval: 'Dear {employee}, your leave request for {date} has been approved by Operations. Smaatech',
        payrollSlip: 'Dear {employee}, your payslip for {date} has been processed. Log in to ESS portal to view details. Smaatech'
      },
      whatsapp: {
        leaveApproval: 'Hello *{employee}*,\n\nYour leave request for *{date}* has been *approved* by your supervisor. ✅\n\nRegards,\nHR Operations',
        payrollSlip: 'Hello *{employee}*,\n\nYour salary slip for *{date}* is ready. You can view or download it under your ESS dashboard. 📊'
      }
    },
    // Multi-level approval settings
    approvalWorkflows: {
      leave: ['HR Manager', 'HR Director'],
      expense: ['Finance Lead', 'HR Director']
    }
  };

  return { settings };
}
