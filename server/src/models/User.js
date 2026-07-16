import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true }, // HR Director | HR Manager | Finance Lead | Employee
  initials: String,
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  active: { type: Boolean, default: true },
  // Hashed (never plaintext) one-time code for password reset, emailed to
  // the real address — replaces the old client-simulated toast.
  otpHash: { type: String, default: null },
  otpExpiresAt: { type: Date, default: null },
}, { timestamps: true });

userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.employeeId) ret.employeeId = String(ret.employeeId);
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.otpHash;
    delete ret.otpExpiresAt;
  },
});

export default mongoose.model('User', userSchema);
