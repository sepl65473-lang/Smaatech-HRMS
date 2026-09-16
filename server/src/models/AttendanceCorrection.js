import mongoose from 'mongoose';

const attendanceCorrectionSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String, required: true },
  date: { type: String, required: true }, // 'YYYY-MM-DD'
  requestedCheckIn: { type: String, required: true }, // 'HH:MM'
  requestedCheckOut: { type: String, required: true }, // 'HH:MM'
  reason: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  // Who decided, when, and why — none of which was recorded before, so an
  // approved correction had no accountable reviewer in the record itself.
  reviewedBy: { type: String, default: '' },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: '' },
  company: { type: String, default: 'Smaatech', index: true }
}, { timestamps: true });

attendanceCorrectionSchema.index({ company: 1, status: 1, createdAt: -1 });
attendanceCorrectionSchema.index({ company: 1, employeeId: 1, date: 1 });

attendanceCorrectionSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.employeeId = String(ret.employeeId);
    delete ret._id;
    delete ret.__v;
  }
});

export default mongoose.model('AttendanceCorrection', attendanceCorrectionSchema);
