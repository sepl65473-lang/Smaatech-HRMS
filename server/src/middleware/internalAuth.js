import crypto from 'node:crypto';
import { requireAuth } from './auth.js';

// Constant-time comparison so a token can't be recovered a byte at a time by
// timing repeated requests. Length is compared first because timingSafeEqual
// throws on mismatched buffer lengths.
export function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Guards internal/operational endpoints (/metrics, /ai/*).
 *
 * These were completely unauthenticated. GET /api/v1/ai/predict and
 * GET /api/v1/metrics handed any anonymous caller the process id, host memory
 * and CPU figures, event-loop lag and database connection state — a free
 * reconnaissance and capacity-probing surface — and POST /api/v1/ai/telemetry
 * let anyone push arbitrary samples into the rolling window the anomaly
 * detector reasons over, so an attacker could poison the baseline until real
 * incidents no longer register as anomalies.
 *
 * Two accepted credentials, because these endpoints have two real callers:
 *   - a scrape token in X-Metrics-Token, for Prometheus/uptime probes that
 *     have no user session;
 *   - a normal HR Director session, for viewing the same data in-app.
 *
 * When METRICS_TOKEN is unset the token path is simply unavailable — it never
 * degrades to "open to everyone".
 */
export function requireInternalAccess(req, res, next) {
  const expected = process.env.METRICS_TOKEN;
  const presented = req.headers['x-metrics-token'];

  if (expected && presented && safeCompare(presented, expected)) {
    req.internalAuth = { via: 'token' };
    return next();
  }

  // Fall back to a signed-in privileged user.
  return requireAuth(req, res, () => {
    if (req.auth?.role !== 'HR Director') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Operational telemetry is restricted.' },
      });
    }
    req.internalAuth = { via: 'session' };
    return next();
  });
}
