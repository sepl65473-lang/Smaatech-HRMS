import mongoose from 'mongoose';

const onboardingItemSchema = new mongoose.Schema({
  id: String,
  label: String,
  done: { type: Boolean, default: false },
}, { _id: false });

const candidateSchema = new mongoose.Schema({
  title: { type: String, required: true },
  candidate: { type: String, required: true },
  stage: { type: String, default: 'Applied' }, // Applied | Screening | Interview | Offer | Hired
  meta: { type: String, default: '' },
  onboarding: { type: [onboardingItemSchema], default: undefined },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

candidateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Candidate', candidateSchema);
