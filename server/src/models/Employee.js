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
  dob: { type: String, default: '' }, // 'YYYY-MM-DD'
  photo: { type: String, default: '' }, // client-resized JPEG data URL (EmployeeForm.jsx)
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  bankAccount: { type: String, default: '' },
  ifsc: { type: String, default: '' },
  company: { type: String, default: 'Smaatech', index: true },
  
  // 360 Lifecycle fields
  gender: { type: String, default: '' },
  bloodGroup: { type: String, default: '' },
  personalEmail: { type: String, default: '' },
  emergencyContact: {
    name: { type: String, default: '' },
    relation: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  bankName: { type: String, default: '' },
  skills: { type: [String], default: [] },
  education: [{
    degree: String,
    institution: String,
    year: String,
    grade: String,
  }],
  experience: [{
    company: String,
    role: String,
    from: String,
    to: String,
  }],
  family: [{
    name: String,
    relation: String,
    phone: String,
  }],
}, { timestamps: true });

// One employee per email per company — partial so employees added without an
// email yet (the form allows leaving it blank) never collide with each other.
employeeSchema.index(
  { company: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string', $gt: '' } } },
);

// Shape the API response to match the frontend's existing `id` (string) convention
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
