import mongoose from 'mongoose';

const assetSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  serialNumber: { type: String, default: '' },
  status: { type: String, default: 'available' }, // available | assigned
  assignedToEmpId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  assignedToEmpName: { type: String, default: '' },
  assignedDate: { type: String, default: '' },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

assetSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.assignedToEmpId) ret.assignedToEmpId = String(ret.assignedToEmpId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Asset', assetSchema);
