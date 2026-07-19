import mongoose from 'mongoose';

const holidaySchema = new mongoose.Schema({
  name: { type: String, required: true },
  date: { type: String, required: true }, // display string, e.g. "7 Jun, Sun" — year-agnostic, recurs yearly
  type: { type: String, default: 'National' }, // National | Regional | Optional
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

holidaySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Holiday', holidaySchema);
