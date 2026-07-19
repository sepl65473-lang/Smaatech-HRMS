import mongoose from 'mongoose';

const attendanceCorrectionSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String, required: true },
  date: { type: String, required: true }, // 'YYYY-MM-DD'
  requestedCheckIn: { type: String, required: true }, // 'HH:MM'
  requestedCheckOut: { type: String, required: true }, // 'HH:MM'
  reason: { type: String, required: true },
  status: { type: String, default: 'Pending' }, // Pending | Approved | Rejected
  company: { type: String, default: 'Smaatech', index: true }
}, { timestamps: true });

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
