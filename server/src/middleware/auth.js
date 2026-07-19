import Role from '../models/Role.js';
import { verifyAccessToken } from '../lib/tokens.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Sign in required.' } });
  }
  try {
    const decoded = verifyAccessToken(token);
    // Normalise: set `id` alias and default `company` for legacy tokens
    decoded.id = decoded.sub;
    decoded.company = decoded.company || 'Smaatech';
    req.auth = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired, please sign in again.' } });
  }
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

// Returns a Mongo filter object that scopes queries to the user's company.
// HR Director can optionally pass ?company=X to filter, but is never forced.
export function companyFilter(req) {
  if (req.auth.role === 'HR Director') {
    return req.query.company ? { company: req.query.company } : {};
  }
  return { company: req.auth.company };
}

