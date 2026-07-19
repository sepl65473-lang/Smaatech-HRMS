import mongoose from 'mongoose';

// Holds settings that are fully database-backed per company.
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' }, // company name
  gpsCheckInEnabled: { type: Boolean, default: false },
  geofenceLat: { type: Number, default: 19.0760 },
  geofenceLng: { type: Number, default: 72.8777 },
  geofenceRadius: { type: Number, default: 25 },
  shifts: { type: mongoose.Schema.Types.Mixed, default: undefined },
  roster: { type: mongoose.Schema.Types.Mixed, default: undefined },
  employeeShifts: { type: mongoose.Schema.Types.Mixed, default: undefined },
  
  orgName: { type: String, default: 'Smaatech' },
  workWeek: { type: String, default: '5-day' },
  notifyLeave: { type: Boolean, default: true },
  notifyPayroll: { type: Boolean, default: true },
  notifyBirthday: { type: Boolean, default: false },
  twoFactor: { type: Boolean, default: true },
  wishesSent: { type: Number, default: 0 },
  totalLeaveDays: { type: Number, default: 24 },
  departments: { type: [String], default: [] },
  designations: { type: [String], default: [] },
  
  gatewayTwilioSid: { type: String, default: '' },
  gatewayTwilioToken: { type: String, default: '' },
  gatewayTwilioFrom: { type: String, default: '' },
  gatewaySendgridKey: { type: String, default: '' },
  gatewaySmtpHost: { type: String, default: '' },
  gatewaySmtpUser: { type: String, default: '' },
  gatewaySmtpPass: { type: String, default: '' },
  
  notificationTemplates: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({
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
    })
  },
  
  notifyChannels: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({
      leave: ['In-app'],
      payroll: ['In-app'],
      birthday: ['In-app']
    })
  },
  
  approvalWorkflows: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({
      leave: ['HR Manager', 'HR Director'],
      expense: ['Finance Lead', 'HR Director']
    })
  }
});

settingsSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Settings', settingsSchema);
