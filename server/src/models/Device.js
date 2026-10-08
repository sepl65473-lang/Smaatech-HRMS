import mongoose from 'mongoose';

// A registered attendance machine (a fixed face + fingerprint terminal).
//
// This is a register of machines, not attendance: a punch from a device is
// written to the same Attendance row as a mobile or web punch. What lives here
// is what the HRMS has to know about the machine itself:
//   - its own credential, so one device can be switched off or re-keyed
//     without touching any other (only a SHA-256 of the key is kept; the key
//     is shown once, when it is generated);
//   - the site it is mounted at, which is the location recorded for its
//     punches when the request carries no GPS of its own.
// No biometric data is stored here or anywhere else for a device: the machine
// does its own face and fingerprint matching and reports who it recognised.
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  keyHash: { type: String, default: '' },
  siteAddress: { type: String, required: true, trim: true },
  siteLat: { type: Number, default: null },
  siteLng: { type: Number, default: null },
  active: { type: Boolean, default: true },
  lastSeenAt: { type: Date, default: null },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

// A device id names one machine across the whole deployment: the device
// presents it with no company context, so it must resolve to exactly one row.
deviceSchema.index({ deviceId: 1 }, { unique: true });

deviceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.hasKey = Boolean(ret.keyHash);
    delete ret.keyHash; // never leaves the server
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Device', deviceSchema);
