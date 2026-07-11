import { verifyAccessToken } from '../lib/tokens.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Sign in required.' } });
  }
  try {
    req.auth = verifyAccessToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired, please sign in again.' } });
  }
}

// HR Director is always a superuser, mirroring src/lib/permissions.js's canDo() on the frontend.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.auth?.role === 'HR Director' || roles.includes(req.auth?.role)) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' } });
  };
}
