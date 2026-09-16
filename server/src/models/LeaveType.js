import mongoose from 'mongoose';

// Configurable leave policy per company.
//
// Before this existed, "leave types" were three free-text strings on the Leave
// document (sick | casual | earned) with no entitlement, no quota and no
// paid/unpaid distinction anywhere on the server — which is why there was
// nothing for a balance check to check against.
const leaveTypeSchema = new mongoose.Schema({
  company: { type: String, required: true, index: true },
  code: { type: String, required: true },       // 'sick' | 'casual' | 'earned' | 'unpaid' | ...
  name: { type: String, required: true },

  // Days granted per leave year. 0 with paid:false is the shape of
  // loss-of-pay leave: always available, never deducted from a balance.
  annualQuota: { type: Number, default: 0 },

  // 'annual'  — the whole quota is credited at the start of the leave year.
  // 'monthly' — quota/12 accrues at each month end, the usual earned-leave
  //             treatment in Indian companies.
  accrualMode: { type: String, enum: ['annual', 'monthly'], default: 'annual' },

  paid: { type: Boolean, default: true },
  carryForward: { type: Boolean, default: false },
  carryForwardCap: { type: Number, default: 0 },

  allowHalfDay: { type: Boolean, default: true },
  // 0 = no limit. Guards a single request swallowing a whole year's quota.
  maxConsecutiveDays: { type: Number, default: 0 },
  // Above this many days a supporting document is expected (medical
  // certificate for extended sick leave, for example).
  documentRequiredAfterDays: { type: Number, default: 0 },

  // Negative balance permitted, for companies that allow advance leave.
  allowNegativeBalance: { type: Boolean, default: false },
  negativeBalanceLimit: { type: Number, default: 0 },

  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

leaveTypeSchema.index({ company: 1, code: 1 }, { unique: true });

leaveTypeSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
  },
});

// Seeded for a company that has never configured leave policy, so the balance
// system has something real to work against from day one rather than silently
// treating every request as unlimited. Quotas follow common Indian private
// sector practice (12 casual, 12 sick, 15 earned with carry-forward) and are
// editable per company — they are a starting default, not a legal minimum.
export const DEFAULT_LEAVE_TYPES = [
  { code: 'casual', name: 'Casual Leave', annualQuota: 12, accrualMode: 'monthly', paid: true, carryForward: false, sortOrder: 1 },
  { code: 'sick', name: 'Sick Leave', annualQuota: 12, accrualMode: 'annual', paid: true, carryForward: false, documentRequiredAfterDays: 3, sortOrder: 2 },
  { code: 'earned', name: 'Earned / Privilege Leave', annualQuota: 15, accrualMode: 'monthly', paid: true, carryForward: true, carryForwardCap: 30, sortOrder: 3 },
  { code: 'unpaid', name: 'Leave Without Pay', annualQuota: 0, accrualMode: 'annual', paid: false, carryForward: false, sortOrder: 4 },
  { code: 'maternity', name: 'Maternity Leave', annualQuota: 182, accrualMode: 'annual', paid: true, carryForward: false, sortOrder: 5 },
  { code: 'paternity', name: 'Paternity Leave', annualQuota: 15, accrualMode: 'annual', paid: true, carryForward: false, sortOrder: 6 },
];

export default mongoose.model('LeaveType', leaveTypeSchema);
