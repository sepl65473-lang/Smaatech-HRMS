import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: String,
  dept: String,
  loc: String,
  email: String,
  phone: String,
  status: { type: String, default: 'active' }, // active | remote | on-leave
  joinDate: String,
  salary: Number,
  rating: Number,
  employmentType: { type: String, default: 'Full-time' }, // Full-time | Part-time | Contract | Intern
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  bankAccount: { type: String, default: '' },
  ifsc: { type: String, default: '' },
}, { timestamps: true });

// Shape the API response to match the frontend's existing `id` (string) convention
// instead of Mongo's `_id`, so store.js can swap localStorage for fetch() with no
// changes anywhere else in the app.
employeeSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.managerId) ret.managerId = String(ret.managerId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Employee', employeeSchema);
