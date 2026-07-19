import mongoose from 'mongoose';

const resignationSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String, required: true },
  resignationDate: { type: String, required: true }, // 'YYYY-MM-DD'
  requestedLastWorkingDay: { type: String, required: true }, // 'YYYY-MM-DD'
  approvedLastWorkingDay: { type: String, default: '' }, // 'YYYY-MM-DD'
  reason: { type: String, required: true },
  status: { type: String, default: 'Submitted' }, // Submitted | Approved | Rejected

  // Exit Clearance Checklist stages
  clearances: [{
    dept: { type: String, required: true }, // IT | Finance | HR | Admin
    status: { type: String, default: 'Pending' }, // Pending | Approved | Rejected
    approvedBy: { type: String, default: '' },
    approvedAt: { type: String, default: '' },
    notes: { type: String, default: '' }
  }],

  // Full & Final (FnF) Settlement calculations
  fnfSettlement: {
    monthlySalary: { type: Number, default: 0 },
    leaveEncashment: { type: Number, default: 0 },
    gratuity: { type: Number, default: 0 },
    otherAllowances: { type: Number, default: 0 },
    loansDeduction: { type: Number, default: 0 },
    assetDeduction: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    netPayout: { type: Number, default: 0 },
    status: { type: String, default: 'Draft' }, // Draft | Processed | Paid
    processedAt: { type: String, default: '' },
    notes: { type: String, default: '' }
  },

  company: { type: String, default: 'Smaatech', index: true }
}, { timestamps: true });

resignationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.employeeId = String(ret.employeeId);
    delete ret._id;
    delete ret.__v;
  }
});

export default mongoose.model('Resignation', resignationSchema);
