import mongoose from 'mongoose';

// Links a biometric device's own internal user id to a real Employee — the
// "unmapped punch → link to employee" reconciliation UI (Integrations.jsx)
// used to only hold this in local React state; persisting it here is what
// lets a real device-punch ingest (POST /attendance/device-punch) resolve
// deviceUserId -> empId on its own, without a human in the loop every time.
const deviceUserMappingSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  deviceUserId: { type: String, required: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

deviceUserMappingSchema.index({ company: 1, deviceId: 1, deviceUserId: 1 }, { unique: true });

deviceUserMappingSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('DeviceUserMapping', deviceUserMappingSchema);
