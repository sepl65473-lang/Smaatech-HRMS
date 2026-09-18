import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true }, // HR Director | HR Manager | Finance Lead | Employee
  initials: String,
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  active: { type: Boolean, default: true },
  status: { type: String, enum: ['Pending', 'Active', 'Inactive', 'Suspended'], default: 'Active' },
  mustChangePassword: { type: Boolean, default: false },
  company: { type: String, default: 'Smaatech', index: true },
  // Hashed (never plaintext) one-time code for password reset, emailed to
  // the real address — replaces the old client-simulated toast.
  otpHash: { type: String, default: null },
  otpExpiresAt: { type: Date, default: null },
  // LEGACY: held the emailed login 2FA code, which has been removed. Nothing
  // writes these any more; kept so existing documents stay valid, and still
  // stripped from JSON below so a stale hash can never be returned.
  loginOtpHash: { type: String, default: null },
  loginOtpExpiresAt: { type: Date, default: null },
  // Per-account brute-force lockout — reset to 0/null on any successful login.
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  // Set only on a genuine human-completed login (password or face) — never on a silent /auth/refresh token renewal.
  lastLoginAt: { type: Date, default: null },
  lastLoginIp: { type: String, default: null },

  // Bumped whenever this account's right to be signed in changes
  // (deactivation, role change, termination, admin password reset). Every
  // access token carries the value it was minted with as a `tv` claim, and
  // requireAuth rejects a token whose `tv` is stale — so a 15-minute access
  // token stops working the instant the account is disabled instead of
  // lingering until it expires. See lib/sessionRevoker.js.
  tokenVersion: { type: Number, default: 0 },
}, { timestamps: true });

// /auth/login, /refresh and requireAuth all look an account up by email or id
// within a company; these back those paths.
userSchema.index({ company: 1, role: 1 });
userSchema.index({ employeeId: 1 });

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
    delete ret.loginOtpHash;
    delete ret.loginOtpExpiresAt;
    delete ret.failedLoginAttempts;
    delete ret.lockedUntil;
    delete ret.tokenVersion;
  },
});

export default mongoose.model('User', userSchema);
