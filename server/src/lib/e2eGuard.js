import logger from './logger.js';

/**
 * Isolated end-to-end test mode.
 *
 * Browser E2E has to get past two things that exist for good reasons and must
 * NOT be weakened in production:
 *
 *   1. login 2FA — a real email OTP nobody can read from a test runner;
 *   2. face verification — a real camera and a real enrolled face.
 *
 * The answer is an isolated mode, not a weakened production path. It is
 * gated by THREE independent conditions that cannot all hold on a real
 * deployment:
 *
 *   - E2E_TEST_MODE must be exactly 'enabled'
 *   - NODE_ENV must NOT be 'production'
 *   - E2E_TEST_SECRET must be set and at least 32 chars, and every request
 *     using the mode must present it
 *
 * On Render, NODE_ENV is 'production', so this is inert there no matter what
 * else is configured. The server also refuses to start if someone tries to
 * turn it on in production — see lib/startupChecks.js.
 */
const REQUIRED_SECRET_LENGTH = 32;

export function isE2EModeEnabled() {
  if (process.env.E2E_TEST_MODE !== 'enabled') return false;
  if (process.env.NODE_ENV === 'production') return false;
  const secret = process.env.E2E_TEST_SECRET || '';
  return secret.length >= REQUIRED_SECRET_LENGTH;
}

/**
 * True only when the caller proved knowledge of the E2E secret AND the mode
 * is genuinely on. Used to skip the OTP step and to accept a deterministic
 * face stand-in, and nothing else.
 */
export function hasValidE2EHeader(req) {
  if (!isE2EModeEnabled()) return false;
  const presented = req.headers['x-e2e-secret'];
  if (typeof presented !== 'string') return false;
  const expected = process.env.E2E_TEST_SECRET;
  if (presented.length !== expected.length) return false;
  // Length-checked constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function warnIfE2EEnabled() {
  if (process.env.E2E_TEST_MODE === 'enabled' && process.env.NODE_ENV !== 'production') {
    logger.warn('[e2e] E2E TEST MODE IS ON — 2FA and face capture have test-only paths. Never enable this on a real deployment.');
  }
}
