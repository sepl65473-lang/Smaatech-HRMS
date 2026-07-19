import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // targeted user, null = global
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'system' }, // leave | payroll | system | celebration
  actionUrl: { type: String, default: '' },
  read: { type: Boolean, default: false },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

notificationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.recipientId) ret.recipientId = String(ret.recipientId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Notification', notificationSchema);
