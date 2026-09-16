import mongoose from 'mongoose';

const payrollSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  gross: { type: Number, default: 0 },
  deductions: { type: Number, default: 0 },
  net: { type: Number, default: 0 },
  status: { type: String, default: 'ready' }, // ready | processing | paid
  cycle: { type: String, required: true }, // YYYY-MM
  lopDays: { type: Number, default: 0 },
  lopAmount: { type: Number, default: 0 },
  components: {
    type: {
      earnings: [{ name: String, amount: Number }],
      deductions: [{ name: String, amount: Number, category: { type: String, enum: ['PF', 'ESI', 'PT', 'TDS', 'Other'], default: 'Other' } }],
    },
    default: undefined,
  },
  company: { type: String, default: 'Smaatech', index: true },

  // Set once when the row is first written, from the caller's Idempotency-Key.
  // Lets a retried/duplicated request be recognised as the SAME logical
  // payroll run rather than a second one.
  idempotencyKey: { type: String, default: null },

  // Locking: once a cycle is approved/paid it must not be silently edited.
  lockedAt: { type: Date, default: null },
  lockedBy: { type: String, default: null },
}, { timestamps: true });

payrollSchema.index({ company: 1, createdAt: -1 });
payrollSchema.index({ company: 1, cycle: 1, status: 1 });

// THE duplicate-payroll guard. Previously nothing stopped a double-clicked
// "Process payroll", a retried request, or two concurrent admins from
// creating several payslips for the same person and month — each one a real
// payable amount. One payroll row per employee per company per cycle,
// enforced by the database itself so concurrent inserts can't both win.
payrollSchema.index(
  { company: 1, empId: 1, cycle: 1 },
  { unique: true, name: 'uniq_company_emp_cycle' },
);

payrollSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Payroll', payrollSchema);
