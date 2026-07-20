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
      // category lets a deduction be tagged as a real statutory scheme
      // (PF/ESI/PT/TDS) instead of a free-text-only line — HR/Finance still
      // enters the amount, this only makes the payslip/ledger export able
      // to itemize by scheme instead of one opaque total.
      deductions: [{ name: String, amount: Number, category: { type: String, enum: ['PF', 'ESI', 'PT', 'TDS', 'Other'], default: 'Other' } }],
    },
    default: undefined,
  },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

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
