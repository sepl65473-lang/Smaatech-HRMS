import mongoose from 'mongoose';

const emailLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email: { type: String, required: true, lowercase: true, trim: true },
  emailType: { type: String, required: true }, // WELCOME | OTP | RESET | SYSTEM
  status: { type: String, enum: ['SENT', 'FAILED'], required: true },
  retryCount: { type: Number, default: 0 },
  failureReason: { type: String, default: '' },
  lastRetryAt: { type: Date, default: null },
  idempotencyKey: { type: String, default: '' },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

emailLogSchema.index({ company: 1, idempotencyKey: 1 }, { partialFilterExpression: { idempotencyKey: { $type: 'string', $gt: '' } } });

emailLogSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.userId) ret.userId = String(ret.userId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('EmailLog', emailLogSchema);
