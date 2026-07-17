import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_COOKIE_NAME = 'sepl_refresh';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, employeeId: user.employeeId ? String(user.employeeId) : null },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

// Refresh tokens are opaque random strings, not JWTs — only their SHA-256
// hash is stored, so a stolen DB dump doesn't hand out usable tokens, and a
// row can be deleted to revoke instantly (unlike a self-contained JWT).
export function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'None' is required for the refresh cookie to survive cross-site fetch()
    // calls once the client (Vercel) and server (Render) live on different
    // domains — browsers won't attach a 'Lax' cookie to those requests.
    // Always paired with secure:true above, since SameSite=None requires it.
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: '/api/v1/auth',
  };
}
