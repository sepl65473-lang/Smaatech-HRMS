import mongoose from 'mongoose';

/**
 * A temporary, employee-specific permission to REDO face enrolment.
 *
 * First-time enrolment is unchanged: an employee with no template still
 * enrols themselves. What used to be self-service — and is now gated — is
 * REPLACING a template that already exists, because that is the step that
 * decides whose face the attendance system will accept from then on.
 *
 * A grant is for one account, expires on its own, and is spent the moment it
 * is used. It grants ACCESS to the normal enrolment flow; it never bypasses
 * face detection or matching, which run exactly as before.
 */
const faceAccessGrantSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  subjectName: { type: String, default: '' },
  subjectEmail: { type: String, default: '' },
  reason: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  grantedBy: {
    id: { type: String, default: null },
    name: { type: String, default: null },
    role: { type: String, default: null },
  },
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revokedBy: {
    id: { type: String, default: null },
    name: { type: String, default: null },
  },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

// Deliberately NOT a TTL index: a spent or expired grant stays as the record
// of who allowed what, and when. Only its ACTIVE window is time-limited.
faceAccessGrantSchema.index({ company: 1, userId: 1, createdAt: -1 });

/** The one state that matters at enrolment time. */
export function grantStatus(grant, now = new Date()) {
  if (!grant) return 'none';
  if (grant.revokedAt) return 'revoked';
  if (grant.usedAt) return 'used';
  if (grant.expiresAt <= now) return 'expired';
  return 'active';
}

faceAccessGrantSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.userId = String(ret.userId);
    if (ret.employeeId) ret.employeeId = String(ret.employeeId);
    ret.status = grantStatus(ret);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('FaceAccessGrant', faceAccessGrantSchema);
