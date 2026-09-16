import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  date: { type: String, required: true }, // YYYY-MM-DD
  checkIn: { type: String, default: null },
  checkOut: { type: String, default: null },
  status: { type: String, default: 'absent' }, // present | late | absent | leave | early-exit | half-day | holiday

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

  // STRUCTURED location, not just a flattened display line.
  //
  // checkInLoc/checkInAddress held "lat, lng" and one joined string, so an
  // attendance record could not show, sort or filter on place name, city or
  // postal code independently, and an auditor could not tell which part of
  // the blob was the PIN. Coordinates are kept alongside — never replaced —
  // because the geofence decision and any later dispute rest on the raw fix.
  // See lib/geocode.js structureAddress().
  checkInLocation: {
    placeName: { type: String, default: null },
    fullAddress: { type: String, default: null },
    pincode: { type: String, default: null },
    area: { type: String, default: null },
    city: { type: String, default: null },
    district: { type: String, default: null },
    state: { type: String, default: null },
    country: { type: String, default: null },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    source: { type: String, default: null }, // nominatim | cache | unresolved
    resolvedAt: { type: String, default: null },
  },
  checkOutLocation: {
    placeName: { type: String, default: null },
    fullAddress: { type: String, default: null },
    pincode: { type: String, default: null },
    area: { type: String, default: null },
    city: { type: String, default: null },
    district: { type: String, default: null },
    state: { type: String, default: null },
    country: { type: String, default: null },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    source: { type: String, default: null },
    resolvedAt: { type: String, default: null },
  },

  // Count of rejected verification attempts against this employee-day, so HR
  // sees "3 failed attempts before this punch" on the record itself rather
  // than having to read the audit log — which only an HR Director can open.
  // The attempts themselves live in models/VerificationAttempt.js.
  failedVerificationCount: { type: Number, default: 0 },
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

// One row per employee per calendar day — lets the daily row-creation job
// (lib/attendanceDailyJob.js) safely re-run without ever double-inserting.
attendanceSchema.index({ empId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ company: 1, date: 1, status: 1 });
attendanceSchema.index({ company: 1, date: -1 });

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
