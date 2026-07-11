import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  date: { type: String, required: true }, // YYYY-MM-DD
  checkIn: { type: String, default: null },
  checkOut: { type: String, default: null },
  status: { type: String, default: 'absent' }, // present | late | absent | leave

  checkInLoc: { type: String, default: null },
  checkOutLoc: { type: String, default: null },
  checkInDetails: { type: String, default: null },
  checkOutDetails: { type: String, default: null },

  // Server-derived verification snapshot — never trusts a client-reported flag.
  checkInVerification: { type: mongoose.Schema.Types.Mixed, default: null },
  checkOutVerification: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

attendanceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Attendance', attendanceSchema);
