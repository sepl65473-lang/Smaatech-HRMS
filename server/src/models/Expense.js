import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  category: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  description: { type: String, default: '' },
  receiptUrl: { type: String, default: '' },
  status: { type: String, default: 'pending' }, // pending | approved | declined
  reason: { type: String, default: '' },
  // Multi-stage approval (see routes/expenses.js) — approvalStages is a
  // snapshot of Settings.approvalWorkflows.expense at creation time, so
  // editing the workflow config later doesn't change requests already in flight.
  approvalStages: { type: [String], default: undefined },
  currentStage: { type: Number, default: 0 },
  approvals: [{
    role: String,
    decision: String, // approved | declined
    at: { type: Date, default: Date.now },
  }],
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

expenseSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Expense', expenseSchema);
