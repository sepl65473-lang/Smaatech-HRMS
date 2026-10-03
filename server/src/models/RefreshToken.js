import mongoose from 'mongoose';

const refreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  userAgent: String,
  ip: String,
  // Where the person was when they signed in, if they chose to share it
  // (POST /auth/login-location). Visibility only: nothing reads this to allow
  // or refuse anything. { status, reason, address, lat, lng, accuracy,
  // capturedAt, resolvedAt } — the address is resolved by the server.
  location: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

// /auth/sessions, revoke-others and every lifecycle revocation filter on
// (userId, revokedAt, expiresAt); without this they collection-scan.
refreshTokenSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

// Mongo removes each row shortly after it expires, so this collection can't
// grow without bound — a 30-day token per login per device adds up fast.
// Revoked-but-unexpired rows are kept until their natural expiry so the
// audit trail of "which device was signed out when" survives.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// The one line shown to a person reading a session list. Never coordinates.
export function sessionLocationLabel(location) {
  if (!location) return null;
  if (location.status !== 'shared') return 'Location not shared';
  return location.address || 'Address unavailable';
}

export default mongoose.model('RefreshToken', refreshTokenSchema);
