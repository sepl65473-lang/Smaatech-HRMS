import mongoose from 'mongoose';

/**
 * Every attendance verification attempt that was REJECTED.
 *
 * Previously a failed face match wrote one line to AuditLog and nothing else:
 *   - the captured photo was discarded, so there was no evidence of WHO tried;
 *   - AuditLog is readable only by an HR Director, so an HR Manager — the role
 *     that actually runs attendance — could not see failed attempts at all;
 *   - there was no count anywhere, so "this person failed six times then got
 *     in" was invisible.
 *
 * That is the exact signal buddy-punching and spoofing produce, so it is
 * recorded as first-class data here, with the photo retained.
 *
 * RETENTION: biometric capture is sensitive personal data. These rows carry a
 * TTL so rejected-attempt photos are not kept indefinitely — the default is 90
 * days, overridable with VERIFICATION_ATTEMPT_RETENTION_DAYS. Successful
 * punches keep their photo on the Attendance row under that record's own
 * lifecycle; this collection is only the rejected ones.
 */
const RETENTION_DAYS = Number(process.env.VERIFICATION_ATTEMPT_RETENTION_DAYS || 90);

const verificationAttemptSchema = new mongoose.Schema({
  company: { type: String, required: true },

  // Who was signed in when the attempt was made. This is the account whose
  // enrolled face the capture was compared AGAINST — recording it is what
  // makes "correct password, wrong face" visible after the fact.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  employeeName: { type: String, default: '' },

  date: { type: String, required: true },      // YYYY-MM-DD (IST)
  time: { type: String, default: null },       // HH:MM (IST)
  direction: { type: String, enum: ['in', 'out'], required: true },

  // What the server decided, and why.
  outcome: { type: String, enum: ['rejected'], default: 'rejected' },
  stage: {
    type: String,
    enum: ['face', 'liveness', 'geofence', 'enrollment', 'photo', 'device'],
    required: true,
  },
  reasonCode: { type: String, required: true },  // FACE_NOT_MATCHED, NO_FACE, OUTSIDE_GEOFENCE...
  reasonMessage: { type: String, default: '' },

  // Face-match numbers, when the comparison actually ran. `distance` is the
  // euclidean distance to the enrolled descriptor: the higher it is, the less
  // like the enrolled person the capture was.
  faceDistance: { type: Number, default: null },
  faceConfidence: { type: Number, default: null },

  // The capture itself — the evidence. Stored through lib/photoStorage.js, so
  // it obeys the same private-bucket rules as every other biometric image and
  // is never publicly addressable.
  photoRef: { type: String, default: null },

  // Where and on what.
  location: {
    placeName: { type: String, default: null },
    fullAddress: { type: String, default: null },
    pincode: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    distanceFromOffice: { type: Number, default: null },
  },
  deviceId: { type: String, default: null },
  device: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: null },
  userAgent: { type: String, default: '' },
}, { timestamps: true });

// HR's review screens: newest-first for a company, and per-employee history.
verificationAttemptSchema.index({ company: 1, createdAt: -1 });
verificationAttemptSchema.index({ company: 1, empId: 1, date: 1 });
verificationAttemptSchema.index({ company: 1, date: 1, stage: 1 });

// Retention. Biometric images must not accumulate forever.
verificationAttemptSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60, name: 'attempt_retention_ttl' },
);

verificationAttemptSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.empId) ret.empId = String(ret.empId);
    if (ret.userId) ret.userId = String(ret.userId);
    delete ret._id;
    delete ret.__v;
    // The storage ref is an internal path; the photo is served only through
    // the authenticated /files route, never by handing out its location.
    delete ret.photoRef;
    return ret;
  },
});

export { RETENTION_DAYS };
export default mongoose.model('VerificationAttempt', verificationAttemptSchema);
