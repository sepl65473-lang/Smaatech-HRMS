import mongoose from 'mongoose';

// Append-only record of every movement of leave.
//
// The balance document is a running total and can be reconciled against this
// ledger at any time; the ledger itself is never updated or deleted, so
// "where did my 3 days go?" always has an answer with an actor, a timestamp
// and the request it came from.
const leaveLedgerSchema = new mongoose.Schema({
  company: { type: String, required: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  year: { type: Number, required: true },
  type: { type: String, required: true },

  // Positive credits days to the employee, negative consumes them.
  delta: { type: Number, required: true },

  // Which bucket on LeaveBalance moved — so an accrual, a manual HR
  // adjustment and a consumption are distinguishable after the fact.
  bucket: {
    type: String,
    enum: ['opening', 'accrued', 'adjusted', 'used', 'pending', 'encashed'],
    required: true,
  },

  reason: {
    type: String,
    enum: [
      'year-opening', 'carry-forward', 'monthly-accrual', 'annual-grant',
      'leave-applied', 'leave-approved', 'leave-declined', 'leave-withdrawn',
      'leave-cancelled', 'hr-adjustment', 'encashment', 'year-end-lapse',
    ],
    required: true,
  },

  refType: { type: String, default: null },  // 'Leave' | 'Payroll' | null
  refId: { type: mongoose.Schema.Types.ObjectId, default: null },

  balanceAfter: { type: Number, default: null }, // available balance after this entry
  note: { type: String, default: '' },
  actor: {
    id: String,
    name: String,
    role: String,
  },
}, { timestamps: true });

leaveLedgerSchema.index({ company: 1, empId: 1, year: 1, type: 1, createdAt: -1 });
leaveLedgerSchema.index({ refType: 1, refId: 1 });

leaveLedgerSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('LeaveLedger', leaveLedgerSchema);
