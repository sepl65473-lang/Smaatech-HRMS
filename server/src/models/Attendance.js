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

  // Audit-trail fields — all derived server-side from the request itself
  // (headers, connection info), never from a client-supplied label.
  checkInAccuracy: { type: Number, default: null },
  checkOutAccuracy: { type: Number, default: null },
  checkInAddress: { type: String, default: null },
  checkOutAddress: { type: String, default: null },
  checkInDeviceId: { type: String, default: null },
  checkOutDeviceId: { type: String, default: null },
  checkInDevice: { type: mongoose.Schema.Types.Mixed, default: null }, // { name, type, browser, os }
  checkOutDevice: { type: mongoose.Schema.Types.Mixed, default: null },
  checkInIp: { type: String, default: null },
  checkOutIp: { type: String, default: null },
  checkInPhotoRef: { type: String, default: null },
  checkOutPhotoRef: { type: String, default: null },
  checkInFaceConfidence: { type: Number, default: null },
  checkOutFaceConfidence: { type: Number, default: null },
  anomalyFlags: { type: [String], default: [] },
  company: { type: String, default: 'Smaatech', index: true },
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
