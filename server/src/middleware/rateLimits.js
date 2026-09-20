import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { verifyAccessToken } from '../lib/tokens.js';
import { isE2EModeEnabled } from '../lib/e2eGuard.js';
import { mobileKey } from '../lib/phoneNumber.js';

/**
 * LAYERED RATE LIMITING.
 *
 * WHY THIS REPLACED THE OLD SCHEME - measured, not theoretical.
 *
 * Every limiter here used to be keyed on the client IP alone:
 *
 *     /api/*            300 requests / 15 min / IP
 *     /auth/login        10 attempts / 15 min / IP
 *
 * That is correct for one person on one connection and catastrophically wrong
 * for an office. A hundred employees behind a single NAT gateway share ONE
 * public address, so they shared ONE bucket: the eleventh person to arrive in
 * the morning got "too many login attempts", and the whole company got roughly
 * fifteen page loads per fifteen minutes between them. Verified against the
 * live deployment, which reported `ratelimit-policy: 10;w=900` on login.
 *
 * The earlier 100-user load test passed only because it gave every virtual
 * user its own X-Forwarded-For. That models a hundred phones on mobile data,
 * not a hundred desks on one office Wi-Fi.
 *
 * THE FIX IS NOT A BIGGER NUMBER. Raising the IP limit to fit an office hands
 * the same allowance to a single attacker. Instead each layer is keyed by the
 * identity that is actually meaningful for the abuse it prevents:
 *
 *   1. ANONYMOUS traffic  -> keyed by IP. Nothing better exists, and it is the
 *                            right granularity for an unauthenticated flood.
 *   2. AUTHENTICATED API  -> keyed by the VERIFIED userId, so one employee's
 *                            activity cannot exhaust a colleague's allowance
 *                            and office size stops mattering.
 *   3. LOGIN              -> three independent layers, because the threats are
 *                            genuinely different (see below).
 *   4. EXPENSIVE ROUTES   -> per-user caps on face/liveness/attendance, which
 *                            cost real CPU, plus an IP backstop.
 *   5. IP CEILING         -> a high per-IP backstop across everything, so
 *                            "register many accounts behind one IP" cannot be
 *                            used to multiply the per-user allowance.
 *
 * The userId comes from verifyAccessToken(), i.e. a signature check. A caller
 * cannot invent a `sub` to win a fresh bucket; an unsigned or tampered token
 * falls back to the IP key.
 */

// Relaxed for automated tests only. Both conditions are impossible on a real
// deployment: NODE_ENV is 'production' there, which also forces
// isE2EModeEnabled() false - see lib/e2eGuard.js.
const isTestEnv = () => process.env.NODE_ENV === 'test' || isE2EModeEnabled();

const MIN = 60 * 1000;
const WINDOW = 15 * MIN;

const num = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * Defaults are sized for the stated production target: 100 employees sharing
 * one office address. Each is overridable so an operator can tighten or loosen
 * without a code change.
 */
export const LIMITS = {
  // Unauthenticated callers, per IP. Unchanged from the old value: this is the
  // one case where per-IP was always the right granularity.
  anonMax: num('RL_ANON_MAX', 300),
  // Authenticated callers, per USER. Roughly 31 full page loads per user per
  // window at the client's current request count.
  userMax: num('RL_USER_MAX', 600),
  // Per-IP backstop across all of /api. 100 staff at ~3 page loads each in a
  // window is ~5,700 requests, so this leaves headroom while still stopping a
  // single host hammering the API.
  ipCeiling: num('RL_IP_CEILING', 20000),
  // Login, per IP. Must fit a whole office arriving at once, with retries.
  loginIpMax: num('RL_LOGIN_IP_MAX', 200),
  // Login, per IP, short window. Allows a simultaneous 100-person rush.
  loginBurstMax: num('RL_LOGIN_BURST_MAX', 120),
  // Login, per ACCOUNT. This is what actually stops credential stuffing
  // against one person, and it is independent of where the attempts come from,
  // so rotating IPs does not help an attacker. Complements the existing
  // 5-strike account lockout in routes/auth.js.
  loginAccountMax: num('RL_LOGIN_ACCOUNT_MAX', 10),
  // Face verification / liveness, per user. Real CPU cost per call.
  faceUserMax: num('RL_FACE_USER_MAX', 30),
  faceIpMax: num('RL_FACE_IP_MAX', 900),
  // Attendance punches, per user. Nobody legitimately punches 40x a window.
  attendanceUserMax: num('RL_ATTENDANCE_USER_MAX', 40),
  // Money movement, per user.
  financialUserMax: num('RL_FINANCIAL_USER_MAX', 60),
};

/** Normalised IP key (IPv6 collapses to a /56 so one host cannot rotate). */
const ipKey = (req) => `ip:${ipKeyGenerator(req.ip || '')}`;

/**
 * The verified user id behind this request, or null.
 * Signature-checked, so the key cannot be forged to win a fresh bucket.
 */
export function verifiedUserId(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const decoded = verifyAccessToken(header.slice(7));
    return decoded && decoded.sub ? String(decoded.sub) : null;
  } catch {
    return null;
  }
}

/** userId when authenticated, IP otherwise. */
export function identityKey(req) {
  const sub = verifiedUserId(req);
  return sub ? `u:${sub}` : ipKey(req);
}

/**
 * Paths that carry their OWN dedicated, layered protection below.
 *
 * These must NOT also be counted against the generic anonymous per-IP bucket.
 * A sign-in is unauthenticated by definition, so without this exclusion a
 * hundred employees signing in from one office address would burn the shared
 * anonymous allowance and start getting 429s - reintroducing, through the back
 * door, the exact shared-bucket failure this module exists to remove. Caught by
 * rateLimits.test.js, which signs in 100 accounts from a single address.
 */
export const SELF_LIMITED_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/login-mobile',
  '/api/v1/auth/face-login',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
];

const isSelfLimited = (req) => {
  // originalUrl, NOT req.path: this limiter is mounted with app.use('/api/'),
  // and Express strips the mount prefix from req.path, so a comparison against
  // the full '/api/v1/auth/login' never matched and the exclusion silently did
  // nothing. rateLimits.test.js catches that regression.
  const path = String(req.originalUrl || req.path || '').split('?')[0];
  return SELF_LIMITED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
};

const tooMany = (code, message) => ({ error: { code, message } });

function limiter({ windowMs = WINDOW, max, keyGenerator, code, message }) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isTestEnv,
    message: tooMany(code, message),
  });
}

// -- Layers 1 + 2: general API ----------------------------------------------
// One limiter, two behaviours: authenticated requests are counted per user and
// get the larger allowance; anonymous ones stay per IP on the smaller one.
export const apiLimiter = rateLimit({
  windowMs: WINDOW,
  max: (req) => (verifiedUserId(req) ? LIMITS.userMax : LIMITS.anonMax),
  keyGenerator: identityKey,
  standardHeaders: true,
  legacyHeaders: false,
  // Sign-in routes are excluded: they have their own three-layer protection
  // and must not be throttled by the shared anonymous bucket as well.
  skip: (req) => isTestEnv() || isSelfLimited(req),
  message: tooMany('TOO_MANY_REQUESTS', 'Too many requests, please try again later.'),
});

// -- Layer 5: per-IP ceiling -------------------------------------------------
// Deliberately generous. Its job is not day-to-day shaping - the per-user
// limiter does that - but to stop one host creating many accounts and using
// them to multiply its own allowance.
export const ipCeilingLimiter = limiter({
  max: LIMITS.ipCeiling,
  keyGenerator: ipKey,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many requests from this network, please try again later.',
});

// -- Layer 3: login, three independent concerns ------------------------------
// (a) sustained volume from one network
export const loginIpLimiter = limiter({
  max: LIMITS.loginIpMax,
  keyGenerator: ipKey,
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Too many sign-in attempts from this network. Please try again in a few minutes.',
});

// (b) a sudden spike from one network, on a short window
export const loginBurstLimiter = limiter({
  windowMs: MIN,
  max: LIMITS.loginBurstMax,
  keyGenerator: ipKey,
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Too many sign-in attempts at once. Please wait a moment and try again.',
});

// (c) attempts against ONE account, wherever they originate. This is the layer
// that defends a specific person's credentials, and rotating source addresses
// does not weaken it.
export const loginAccountLimiter = limiter({
  max: LIMITS.loginAccountMax,
  keyGenerator: (req) => {
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (email) return `acct:${email}`;
    // Mobile sign-in names the same account by a different identifier, so it
    // needs its own per-account bucket rather than falling back to the IP one.
    const mobile = mobileKey(req.body && req.body.mobile);
    return mobile ? `acct:mobile:${mobile}` : ipKey(req);
  },
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Too many sign-in attempts for this account. Please try again in a few minutes.',
});

// -- Layer 4: expensive endpoints --------------------------------------------
export const faceUserLimiter = limiter({
  max: LIMITS.faceUserMax,
  keyGenerator: identityKey,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many verification attempts. Please wait a moment before trying again.',
});

export const faceIpLimiter = limiter({
  max: LIMITS.faceIpMax,
  keyGenerator: ipKey,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many verification attempts from this network. Please try again shortly.',
});

export const attendanceUserLimiter = limiter({
  max: LIMITS.attendanceUserMax,
  keyGenerator: identityKey,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many attendance requests. Please wait a moment before trying again.',
});

export const financialUserLimiter = limiter({
  max: LIMITS.financialUserMax,
  keyGenerator: identityKey,
  code: 'TOO_MANY_REQUESTS',
  message: 'Too many transaction requests. Please try again later.',
});
