import mongoose from 'mongoose';

// Singleton document (one row, fixed _id) holding the settings the server
// must be authoritative for. Everything else in the app's "settings" object
// stays client-side in localStorage for now (see src/data/store.js) — this
// collection only owns the fields attendance verification depends on.
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  gpsCheckInEnabled: { type: Boolean, default: false },
  geofenceLat: { type: Number, default: 19.0760 },
  geofenceLng: { type: Number, default: 72.8777 },
  geofenceRadius: { type: Number, default: 25 },
  // Shift definitions + assignments — kept in lock-step with the client so the
  // server's late/present calculation (src/lib/shifts.js on the frontend,
  // ported to server/src/lib/shifts.js) matches whatever HR actually configured
  // in Settings > Roster, instead of silently falling back to defaults.
  shifts: { type: mongoose.Schema.Types.Mixed, default: undefined },
  roster: { type: mongoose.Schema.Types.Mixed, default: undefined },
  employeeShifts: { type: mongoose.Schema.Types.Mixed, default: undefined },
});

settingsSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Settings', settingsSchema);
