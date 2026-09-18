import crypto from 'node:crypto';
import logger from './logger.js';
import { assertStorageConfigured } from './photoStorage.js';

const REQUIRED = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const MIN_SECRET_LENGTH = 32;

// Values that have appeared as placeholders in this repo's own deployment
// files. Refusing them by name is crude but catches the exact failure mode
// docker-compose.yml previously shipped with:
// JWT_ACCESS_SECRET=production-jwt-secret-change-me.
const KNOWN_PLACEHOLDERS = new Set([
  'production-jwt-secret-change-me',
  'change-me', 'changeme', 'secret', 'password', 'test-access-secret', 'test-refresh-secret',
]);

/**
 * Boot-time configuration gate.
 *
 * The point is to fail LOUDLY at startup instead of serving traffic that is
 * quietly broken or insecure. Previously the process started regardless:
 * db.js threw only on the first request, a missing JWT secret surfaced as a
 * confusing jsonwebtoken error mid-login, and a weak secret produced no
 * signal at all.
 *
 * Returns { ok, errors, warnings }. In production, errors are fatal.
 */
export function runStartupChecks({ env = process.env, strict = env.NODE_ENV === 'production' } = {}) {
  const errors = [];
  const warnings = [];

  for (const key of REQUIRED) {
    if (!env[key]) errors.push(`${key} is not set.`);
  }

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = env[key];
    if (!value) continue;
    if (KNOWN_PLACEHOLDERS.has(value.toLowerCase())) {
      errors.push(`${key} is a known placeholder value — anyone reading this repository can forge tokens. Generate a real one.`);
    } else if (strict && value.length < MIN_SECRET_LENGTH) {
      errors.push(`${key} is only ${value.length} characters; use at least ${MIN_SECRET_LENGTH} (node -e "console.log(require('crypto').randomBytes(48).toString('hex'))").`);
    }
  }

  // E2E test mode must be impossible on a real deployment.
  if (strict && env.E2E_TEST_MODE === 'enabled') {
    errors.push('E2E_TEST_MODE=enabled in production. That mode accepts a test face stand-in — it must never be set on a real deployment.');
  }

  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical — they must be different keys.');
  }

  if (strict && !env.CLIENT_ORIGIN) {
    // Without this the CORS allow-list is empty in production, so the browser
    // client cannot call the API at all.
    errors.push('CLIENT_ORIGIN is not set — the CORS allow-list would be empty and the web client could not reach this API.');
  }

  if (strict && !env.BREVO_API_KEY) {
    // Not fatal, but password-reset and welcome emails depend on it.
    warnings.push('BREVO_API_KEY is not set — password-reset and welcome emails will not be delivered.');
  }

  if (strict && env.ENABLE_CLUSTER === 'true' && env.RUN_SCHEDULERS !== 'false' && !env.SCHEDULER_WORKER_ID) {
    warnings.push('Clustering is on without SCHEDULER_WORKER_ID; scheduled jobs default to worker 1 only.');
  }

  try {
    const storage = assertStorageConfigured(env);
    if (strict && !storage.durable && !env.ALLOW_EPHEMERAL_STORAGE) {
      warnings.push('Uploads are on local disk in production — attendance photos and documents are lost on redeploy unless that path is a persistent volume.');
    }
  } catch (err) {
    errors.push(err.message);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function enforceStartupChecks(options = {}) {
  const { ok, errors, warnings } = runStartupChecks(options);
  for (const warning of warnings) logger.warn('[startup] %s', warning);

  if (!ok) {
    for (const error of errors) logger.error('[startup] %s', error);
    if (options.strict ?? process.env.NODE_ENV === 'production') {
      throw new Error(`Refusing to start: ${errors.length} configuration problem(s). See the [startup] log lines above.`);
    }
    logger.warn('[startup] continuing in non-production despite %d configuration problem(s).', errors.length);
  }
  return { ok, errors, warnings };
}

/** Convenience for operators: `node -e "...generateSecret()"`. */
export function generateSecret() {
  return crypto.randomBytes(48).toString('hex');
}
