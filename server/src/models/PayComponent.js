import mongoose from 'mongoose';

/**
 * A one-off amount that belongs to a specific employee and payroll cycle:
 * overtime, a bonus, an incentive, arrears, a reimbursement, or an ad-hoc
 * deduction.
 *
 * WHY: payroll could only ever pay a fixed monthly gross minus statutory
 * deductions and loss of pay. Anything variable — overtime worked, a quarterly
 * incentive, a backdated arrear from a salary revision — had nowhere to live,
 * so it was either paid outside the system or not at all, and the payslip did
 * not reflect what the person was actually paid.
 *
 * Kept as its own collection rather than fields on Payroll because these are
 * raised and approved BEFORE the cycle is run, by different people, and each
 * one needs its own approval trail.
 */
export const EARNING_KINDS = ['overtime', 'bonus', 'incentive', 'arrear', 'reimbursement', 'other-earning'];
export const DEDUCTION_KINDS = ['advance-recovery', 'other-deduction'];
export const PAY_COMPONENT_KINDS = [...EARNING_KINDS, ...DEDUCTION_KINDS];

const payComponentSchema = new mongoose.Schema({
  company: { type: String, required: true, index: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employeeName: { type: String, default: '' },

  cycle: { type: String, required: true }, // 'YYYY-MM'
  kind: { type: String, enum: PAY_COMPONENT_KINDS, required: true },

  // Always positive. Whether it adds to or subtracts from pay is decided by
  // `kind`, so a sign error cannot turn a deduction into a payment.
  amount: { type: Number, required: true, min: 0 },

  // Overtime only: the hours claimed and the rate they were valued at, kept so
  // a payslip line can be explained rather than just asserted.
  hours: { type: Number, default: 0 },
  hourlyRate: { type: Number, default: 0 },
  multiplier: { type: Number, default: 0 },

  description: { type: String, default: '' },

  // draft    — raised, not yet submitted for approval
  // pending  — awaiting approval
  // approved — will be included when the cycle is run
  // rejected — will not be paid
  // paid     — the cycle that included it has been disbursed
  status: { type: String, default: 'pending', index: true },

  raisedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
    role: { type: String, default: '' },
  },
  approvedBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
    role: { type: String, default: '' },
  },
  decidedAt: { type: Date, default: null },
  decisionNote: { type: String, default: '' },

  // Set once the cycle has been run, so a component can never be counted into
  // two payslips.
  payrollId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null },

  // Guards a double-click or a retried request from raising the same amount
  // twice. Unique only where set.
  dedupeKey: { type: String, default: null },
}, { timestamps: true });

payComponentSchema.index({ company: 1, cycle: 1, status: 1 });
payComponentSchema.index({ company: 1, empId: 1, cycle: 1 });
payComponentSchema.index(
  { company: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

payComponentSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.models.PayComponent || mongoose.model('PayComponent', payComponentSchema);
