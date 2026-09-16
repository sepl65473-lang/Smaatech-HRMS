import mongoose from 'mongoose';

const refreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  userAgent: String,
  ip: String,
}, { timestamps: true });

// /auth/sessions, revoke-others and every lifecycle revocation filter on
// (userId, revokedAt, expiresAt); without this they collection-scan.
refreshTokenSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

// Mongo removes each row shortly after it expires, so this collection can't
// grow without bound — a 30-day token per login per device adds up fast.
// Revoked-but-unexpired rows are kept until their natural expiry so the
// audit trail of "which device was signed out when" survives.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RefreshToken', refreshTokenSchema);
