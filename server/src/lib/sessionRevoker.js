import RefreshToken from '../models/RefreshToken.js';
import User from '../models/User.js';
import logger from './logger.js';
import { invalidateAccountStateCache } from '../middleware/auth.js';

/**
 * Revokes every live refresh token for a user.
 *
 * Needed anywhere the person's right to be signed in changes: deactivation,
 * role change, termination, F&F payout, employee deletion, admin password
 * reset. Previously none of those paths touched RefreshToken at all, so a
 * deactivated or exited employee kept a valid 30-day refresh token and could
 * keep minting fresh access tokens.
 */
export async function revokeAllSessions(userId, { reason = '' } = {}) {
  if (!userId) return 0;
  const result = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { revokedAt: new Date() },
  );
  if (result.modifiedCount > 0) {
    logger.info('[session] revoked %d session(s) for user %s%s', result.modifiedCount, userId, reason ? ` (${reason})` : '');
  }
  return result.modifiedCount;
}

/**
 * Bumps the user's tokenVersion, which invalidates every already-issued
 * ACCESS token immediately.
 *
 * Revoking refresh tokens alone still leaves an outstanding 15-minute access
 * token working on every endpoint — long enough for someone who was just
 * terminated to export payroll or delete records. requireAuth compares the
 * `tv` claim in the token against this field, so bumping it is an instant,
 * stateless-to-verify kill switch.
 */
export async function invalidateAccessTokens(userId) {
  if (!userId) return;
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  // requireAuth caches account state for a few seconds; drop it now so the
  // very next request sees the bumped version rather than waiting out the TTL.
  invalidateAccountStateCache(userId);
}

/** Full logout-everywhere: both token classes, used by every lifecycle exit. */
export async function terminateAllAccess(userId, { reason = '' } = {}) {
  const revoked = await revokeAllSessions(userId, { reason });
  await invalidateAccessTokens(userId);
  return revoked;
}
