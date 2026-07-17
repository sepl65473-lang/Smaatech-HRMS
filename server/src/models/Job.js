import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  title: { type: String, required: true },
  department: String,
  location: String,
  type: String, // Full-time | Part-time | Contract | Internship
  status: { type: String, default: 'Open' }, // Open | Closed
  description: { type: String, default: '' },
}, { timestamps: true });

jobSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Job', jobSchema);
