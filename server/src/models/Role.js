import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  allowedPaths: { type: [String], default: [] },
  allowedActions: { type: [String], default: [] },
}, { timestamps: true });

roleSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Role', roleSchema);
