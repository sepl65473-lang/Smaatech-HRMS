import Role from '../models/Role.js';
import User from '../models/User.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { getCache, setCache, invalidateCache } from '../lib/cacheStore.js';

// How long a verified account's active/tokenVersion state may be reused
// before it is re-read. Short enough that a deactivation takes effect within
// seconds, long enough that a burst of requests from one user doesn't turn
// into a database read per request.
const ACCOUNT_STATE_TTL_MS = 10 * 1000;

async function loadAccountState(userId) {
  const key = `acct:${userId}`;
  const cached = getCache(key);
  if (cached) return cached;
  const user = await User.findById(userId).select('active status tokenVersion role company mustChangePassword').lean();
  const state = user
    ? {
      exists: true,
      active: user.active !== false,
      status: user.status,
      tokenVersion: user.tokenVersion || 0,
      role: user.role,
      company: user.company,
      mustChangePassword: user.mustChangePassword === true,
    }
    : { exists: false };
  setCache(key, state, ACCOUNT_STATE_TTL_MS);
  return state;
}

// Called right after any write that changes whether an account may act, so
// the next request re-reads instead of waiting out the TTL.
export function invalidateAccountStateCache(userId) {
  invalidateCache(`acct:${userId}`);
}

/**
 * Verifies the bearer token AND that the account behind it may still act.
 *
 * The signature check alone is not enough: an access token lives 15 minutes,
 * so a user who was just deactivated, terminated, or had their role changed
 * previously kept full working access on every endpoint for the remainder of
 * that window. Only /auth/me and /auth/refresh ever re-checked `active`.
 *
 * Two extra checks close that:
 *   - the account still exists and is active;
 *   - the token's `tv` claim still matches the account's tokenVersion, which
 *     lib/sessionRevoker.js bumps on any access-changing event.
 */

/**
 * While an account still holds its TEMPORARY password, only these routes work.
 *
 * "You must change your password" was a banner and a modal, and nothing more:
 * the page behind it still rendered and every API endpoint still answered, so
 * anyone who closed the modal — or simply called the API — had full access on a
 * password that was emailed to them in plain text. The requirement is now
 * enforced where it matters.
 */
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
  '/api/v1/auth/refresh',
  '/api/v1/health',
]);

function isAllowedWhilePasswordChangePending(req) {
  const path = (req.baseUrl || '') + (req.path || '');
  return PASSWORD_CHANGE_ALLOWED.has(path.replace(/\/$/, ''));
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Sign in required.' } });
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired, please sign in again.' } });
  }

  try {
    const state = await loadAccountState(decoded.sub);
    if (!state.exists) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired, please sign in again.' } });
    }
    if (!state.active || state.status === 'Suspended') {
      return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account has been deactivated.' } });
    }
    if ((decoded.tv || 0) !== state.tokenVersion) {
      return res.status(401).json({ error: { code: 'TOKEN_REVOKED', message: 'Your access changed — please sign in again.' } });
    }
    // Trust the stored role over the token's copy: a role downgrade must take
    // effect immediately, not at the next token refresh.
    decoded.role = state.role || decoded.role;
    decoded.mustChangePassword = state.mustChangePassword === true;

    if (decoded.mustChangePassword && !isAllowedWhilePasswordChangePending(req)) {
      return res.status(403).json({
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You signed in with a temporary password. Change it before using the application.',
        },
      });
    }
  } catch {
    return res.status(503).json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Could not verify your session, please retry.' } });
  }

  // Normalise: set `id` alias and default `company` for legacy tokens
  decoded.id = decoded.sub;
  decoded.company = decoded.company || 'Smaatech';
  req.auth = decoded;
  return next();
}

const ROUTE_ACTION_MAP = {
  '/api/v1/employees': 'manageEmployees',
  '/api/v1/attendance': 'manageAttendance',
  '/api/v1/leaves': 'manageLeave',
  '/api/v1/payroll': 'managePayroll',
  '/api/v1/recruitment': 'manageRecruitment',
  '/api/v1/jobs': 'manageRecruitment',
  '/api/v1/reviews': 'manageReviews',
  '/api/v1/expenses': 'manageExpenses',
  '/api/v1/assets': 'manageAssets',
  '/api/v1/holidays': 'manageEmployees',
  '/api/v1/celebrations': 'manageEmployees',
  '/api/v1/settings': 'manageSettings',
  '/api/v1/users': 'manageUsers',
  '/api/v1/roles': 'manageRoles',
};

// HR Director is always a superuser, mirroring src/lib/permissions.js's canDo() on the frontend.
export function requireRole(...rolesOrActions) {
  return async (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Sign in required.' } });
    }

    if (req.auth.role === 'HR Director') return next();

    try {
      const roleDef = await Role.findOne({ name: req.auth.role });
      if (!roleDef) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' } });
      }

      // 1. Dynamic Check: Look up action based on request path
      const mappedAction = ROUTE_ACTION_MAP[req.baseUrl];
      if (mappedAction && roleDef.allowedActions.includes(mappedAction)) {
        return next();
      }

      // 2. Compatibility Check: If the user's role is explicitly passed in rolesOrActions
      if (rolesOrActions.includes(req.auth.role)) {
        return next();
      }

      // 3. Dynamic Check: If any of the arguments are actions and the role has that action
      const hasAction = rolesOrActions.some((act) => roleDef.allowedActions.includes(act));
      if (hasAction) return next();

      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' } });
    } catch (err) {
      console.error('[auth middleware] error checking role permissions:', err);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify permissions.' } });
    }
  };
}

// Returns a Mongo filter object that scopes queries to the caller's own
// company. Always scoped — including for HR Director. That role is a
// per-company superuser (requireRole() above lets it bypass permission
// checks within its own tenant), not a cross-tenant platform admin; the
// old code granted `{}` (no scope at all) for any HR Director account,
// which would let one company's HR Director read/edit/delete every other
// company's records once more than one company exists. If a genuine
// cross-company platform-admin capability is ever needed, it should be a
// separate, explicit flag — not implied by this tenant-scoped role name.
export function companyFilter(req) {
  return { company: req.auth.company };
}

