import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  owner: { type: String, required: true }, // display name of owner
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  folder: { type: String, required: true }, // policies | payslips | leave | people
  type: { type: String, default: 'PDF' }, // PDF | DOC | IMG | XLS
  visibility: { type: String, default: 'all' }, // all | hr | finance
  fileRef: { type: String, default: '' }, // relative path to disk storage
  expiryDate: { type: String, default: '' }, // 'YYYY-MM-DD'
  reminderSent: { type: Boolean, default: false },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

documentSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.ownerId) ret.ownerId = String(ret.ownerId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Document', documentSchema);
