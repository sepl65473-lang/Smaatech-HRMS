import mongoose from 'mongoose';

const masterValueSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterCategory', required: true },
  value: { type: String, required: true },
  active: { type: Boolean, default: true },
  company: { type: String, required: true },
}, { timestamps: true });

masterValueSchema.index({ company: 1, categoryId: 1 });

masterValueSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.categoryId = String(ret.categoryId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('MasterValue', masterValueSchema);
