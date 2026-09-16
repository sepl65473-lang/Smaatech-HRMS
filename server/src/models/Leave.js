import mongoose from 'mongoose';

const leaveSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  type: { type: String, required: true }, // sick | casual | earned
  start: { type: String, required: true }, // YYYY-MM-DD
  end: { type: String, required: true },
  status: { type: String, default: 'pending' }, // pending | approved | declined | withdrawn | cancelled
  // Mandatory when declining — an employee is entitled to know why, and the
  // previous implementation recorded no reason at all.
  declineReason: { type: String, default: '' },
  // Which leave year this request draws from, pinned at filing time so a
  // year-boundary change later can't silently move the deduction.
  leaveYear: { type: Number, default: null },
  reason: { type: String, default: '' },
  attachment: { type: String, default: '' },
  isHalfDay: { type: Boolean, default: false },
  halfDayTiming: { type: String, enum: ['first-half', 'second-half', ''], default: '' },
  workingDays: { type: Number, default: 0 },
  // Multi-stage approval (see routes/leave.js) — approvalStages is a snapshot
  // of Settings.approvalWorkflows.leave at creation time, so editing the
  // workflow config later doesn't change requests already in flight.
  approvalStages: { type: [String], default: undefined },
  currentStage: { type: Number, default: 0 },
  approvals: [{
    role: String,          // the stage decided, plus how the actor qualified
    decision: String,      // approved | declined
    by: String,            // who actually decided — previously not recorded
    byId: String,
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  }],
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

leaveSchema.index({ company: 1, status: 1, start: 1 });
leaveSchema.index({ company: 1, createdAt: -1 });
// Backs the overlap check on every filing and the per-employee history view.
leaveSchema.index({ company: 1, empId: 1, status: 1, start: 1, end: 1 });

leaveSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Leave', leaveSchema);
