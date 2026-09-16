import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: String,
  dept: String,
  loc: String,
  email: String,
  phone: String,
  status: { type: String, default: 'active' }, // active | remote | on-leave
  onboardingStatus: {
    type: String,
    enum: ['Created', 'Account Created', 'Invited', 'Activated', 'First Login', 'Profile Completed', 'HR Verified', 'Active'],
    default: 'Created',
  },
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

  // Salary structure. PF and the Professional Tax slabs are computed on
  // basic+DA and gross respectively (lib/statutory.js), so these are the
  // inputs that make statutory deduction real rather than hand-entered. When
  // `basic` is left null the engine assumes 50% of gross AND says so in its
  // warnings, rather than quietly producing a wrong PF figure.
  basic: { type: Number, default: null },
  da: { type: Number, default: 0 },
  hra: { type: Number, default: 0 },
  pfApplicable: { type: Boolean, default: true },
  pfOnFullWages: { type: Boolean, default: false },

  // Statutory identity — the reference numbers PF/ESI/PT/TDS are filed under.
  // lib/statutory.js computes the amounts; these identify the accounts they
  // are remitted to, and their absence is surfaced as a warning on the payslip.
  pan: { type: String, default: '' },
  uan: { type: String, default: '' },
  esiNumber: { type: String, default: '' },
  taxRegime: { type: String, enum: ['old', 'new'], default: 'new' },
  state: { type: String, default: '' }, // for Professional Tax — distinct from `loc` (city)


  /**
   * EMPLOYMENT LIFECYCLE STATE.
   *
   * These are maintained by the lifecycle-event pipeline
   * (routes/lifecycle.js), never written directly by a client. Each change is
   * an immutable LifecycleEvent, so "when was she confirmed, by whom, and what
   * did her salary go from and to" is answerable from the record rather than
   * from whoever remembers.
   */
  employmentStage: {
    type: String,
    enum: ['Probation', 'Confirmed', 'Notice Period', 'Exited'],
    default: 'Probation',
    index: true,
  },
  // Computed from joinDate + Settings.employmentPolicy.probationMonths at hire,
  // and moved by an explicit probation extension — never silently.
  probationEndDate: { type: String, default: '' }, // 'YYYY-MM-DD'
  confirmationDate: { type: String, default: '' }, // 'YYYY-MM-DD'

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
employeeSchema.index({ company: 1, dept: 1, status: 1 });
// Drives the "who is due for confirmation" queue.
employeeSchema.index({ company: 1, employmentStage: 1, probationEndDate: 1 });

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
