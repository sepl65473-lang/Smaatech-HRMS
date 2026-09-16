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

  // Contact and role detail. Hiring previously had nothing to work from: a
  // candidate reached the "Hired" column and stopped there, because there was
  // no email, department or salary to create an employee record with — so
  // somebody re-typed it all into the employee form and the link between the
  // two was lost.
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  dept: { type: String, default: '' },
  loc: { type: String, default: '' },
  employmentType: { type: String, default: 'Full-time' },

  /**
   * THE OFFER.
   *
   * Kept on the candidate rather than invented at hire time, so what was
   * offered, when, and what the person said is a record — not something
   * reconstructed from memory once they have started.
   */
  offer: {
    salary: { type: Number, default: null },
    basic: { type: Number, default: null },
    joiningDate: { type: String, default: '' }, // 'YYYY-MM-DD'
    // draft | sent | accepted | declined | withdrawn
    status: { type: String, default: 'draft' },
    sentAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    note: { type: String, default: '' },
    declineReason: { type: String, default: '' },
  },

  // Set once the candidate has been turned into an employee. It is what makes
  // hiring idempotent: a second attempt returns the same employee instead of
  // creating a duplicate person.
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },

  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

candidateSchema.index({ company: 1, stage: 1 });

candidateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.employeeId) ret.employeeId = String(ret.employeeId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Candidate', candidateSchema);
