// Vercel serverless entry point.
//
// This file used to hand-rebuild a SECOND, divergent Express app: it declared
// its own middleware stack and its own route list, and that list had silently
// drifted from server/src/app.js. Missing from it were /face (biometric
// enrollment + status + revoke), /device-punch (biometric terminal ingest),
// /device-mappings, /health, /metrics and /ai — so every one of those endpoints
// 404'd in the deployed product while working perfectly in local development
// and in the test suite. It also applied `cors({ origin: true })`, which
// reflects ANY origin back with credentials:true, and it carried no rate
// limiting at all.
//
// The fix is to stop maintaining two route tables. There is now exactly one
// app definition (server/src/app.js); this file adds only what is genuinely
// serverless-specific: per-invocation config validation and DB connection.
import { connectDB } from '../server/src/db.js';
import app from '../server/src/app.js';

// Fail closed and loudly rather than booting a server that would sign tokens
// with `undefined` or connect nowhere. Checked per-request because a
// serverless instance can be created before the environment is fully applied.
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

let connectionPromise = null;

// Reuse one connection across warm invocations of the same instance; a new
// connection per request exhausts an Atlas connection pool almost immediately.
function ensureConnected() {
  if (!connectionPromise) {
    connectionPromise = connectDB().catch((err) => {
      // Don't cache a failed connection — the next request should retry.
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

export default async function handler(req, res) {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: {
        code: 'MISSING_CONFIG',
        message: `Server misconfigured: missing ${missing.join(', ')}. Set these in Vercel's Environment Variables.`,
      },
    }));
  }

  try {
    await ensureConnected();
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: { code: 'DB_UNAVAILABLE', message: 'Database unavailable, please retry.' },
    }));
  }

  return app(req, res);
}
