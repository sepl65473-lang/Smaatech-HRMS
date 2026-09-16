import mongoose from 'mongoose';

// Materialised per-employee, per-type, per-leave-year balance.
//
// This is the record the server checks before approving leave. It did not
// exist: the only balance figure in the product was computed in the browser
// from whatever leave rows the client happened to be holding, so an employee
// with zero days left could file and have approved as much leave as they
// liked, and two overlapping approvals could both "succeed".
//
// Every field here is only ever moved through lib/leaveLedger.js, which
// writes a matching immutable LeaveLedger entry in the same operation.
const leaveBalanceSchema = new mongoose.Schema({
  company: { type: String, required: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  year: { type: Number, required: true },   // leave year, e.g. 2026
  type: { type: String, required: true },   // LeaveType.code

  // Credits
  opening: { type: Number, default: 0 },         // carried in from last year
  accrued: { type: Number, default: 0 },         // granted this year so far
  adjusted: { type: Number, default: 0 },        // manual HR correction (+/-)

  // Debits
  used: { type: Number, default: 0 },            // approved and consumed
  pending: { type: Number, default: 0 },         // filed, awaiting approval
  encashed: { type: Number, default: 0 },

  // Bookkeeping for the monthly accrual job, so a re-run is a no-op.
  lastAccruedMonth: { type: Number, default: 0 }, // 1-12, 0 = never
}, { timestamps: true });

// One balance row per employee per type per year — the constraint that makes
// concurrent grants and deductions safe.
leaveBalanceSchema.index({ company: 1, empId: 1, year: 1, type: 1 }, { unique: true });
leaveBalanceSchema.index({ company: 1, year: 1, type: 1 });

leaveBalanceSchema.virtual('credited').get(function credited() {
  return (this.opening || 0) + (this.accrued || 0) + (this.adjusted || 0);
});

// What the employee may still apply for: credits, minus what is already
// consumed AND what is already sitting in an unapproved request. Counting
// pending is what stops someone filing the same last 3 days twice over.
leaveBalanceSchema.virtual('available').get(function available() {
  return this.credited - (this.used || 0) - (this.pending || 0) - (this.encashed || 0);
});

leaveBalanceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('LeaveBalance', leaveBalanceSchema);
