// Deployment route parity.
//
// api/index.js (Vercel) used to hand-rebuild a SECOND Express app with its own
// route list, and that list had silently drifted from server/src/app.js.
// Missing from it: /face (biometric enrollment, status, revoke), /device-punch
// (biometric terminal ingest), /device-mappings, /health, /metrics and /ai.
// Every one of those 404'd in the deployed product while passing locally and
// in CI — the worst possible failure shape, because nothing tested it.
//
// api/index.js now delegates to the single app definition, and this test
// asserts that every route the app mounts is actually reachable, so a future
// edit cannot quietly re-open the gap.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const app = (await import('./app.js')).default;

// Every API surface this product is expected to expose. A route that responds
// 404 here is missing; 401/403 means it exists and is guarded, which is the
// correct answer for an unauthenticated probe.
const EXPECTED_ROUTES = [
  ['get', '/api/v1/employees'],
  ['get', '/api/v1/users'],
  ['get', '/api/v1/attendance'],
  ['get', '/api/v1/attendance/summary'],
  ['get', '/api/v1/attendance/liveness/challenge'],
  ['get', '/api/v1/attendance-corrections'],
  ['get', '/api/v1/settings'],
  ['get', '/api/v1/leaves'],
  ['get', '/api/v1/leaves/types'],
  ['get', '/api/v1/leaves/balance'],
  ['get', '/api/v1/leaves/ledger'],
  ['get', '/api/v1/payroll'],
  ['get', '/api/v1/holidays'],
  ['get', '/api/v1/recruitment'],
  ['get', '/api/v1/reviews'],
  ['get', '/api/v1/expenses'],
  ['get', '/api/v1/assets'],
  ['get', '/api/v1/jobs'],
  ['get', '/api/v1/celebrations'],
  ['get', '/api/v1/roles'],
  ['get', '/api/v1/master-data'],
  ['get', '/api/v1/audit-logs'],
  ['get', '/api/v1/notifications'],
  ['get', '/api/v1/documents'],
  ['get', '/api/v1/resignations'],
  // The six that were missing from the serverless deployment:
  ['get', '/api/v1/face/status/000000000000000000000000'],
  ['post', '/api/v1/device-punch'],
  ['get', '/api/v1/device-mappings'],
  ['get', '/api/v1/health'],
  ['get', '/api/v1/metrics'],
  ['get', '/api/v1/ai/predict'],
];

describe('every expected API route is mounted', () => {
  for (const [method, routePath] of EXPECTED_ROUTES) {
    it(`${method.toUpperCase()} ${routePath} exists`, async () => {
      const res = await request(app)[method](routePath);
      // 404 would mean the route is not mounted at all. Anything else — 401,
      // 403, 400, 200 — proves it is reachable.
      expect(res.status).not.toBe(404);
    });
  }

  it('a genuinely unknown route still 404s, so the check above means something', async () => {
    const res = await request(app).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
  });
});

describe('the serverless entry point does not maintain its own route table', () => {
  const serverlessEntry = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../api/index.js'),
    'utf8',
  );

  // The file explains the old bugs in prose, so matching the explanation
  // rather than the code would make these assertions unsatisfiable.
  const codeOnly = serverlessEntry
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10));

  it('imports the shared app rather than rebuilding one', () => {
    expect(codeOnly).toMatch(/from '\.\.\/server\/src\/app\.js'/);
  });

  it('declares no app.use route mounts of its own', () => {
    // The actual regression guard: the moment someone adds
    // app.use('/api/v1/...') back into the serverless entry, the two
    // deployments can diverge again.
    const mounts = codeOnly.match(/app\.use\(\s*['"`]\/api/g) || [];
    expect(mounts).toHaveLength(0);
  });

  it('does not build its own CORS or reflect arbitrary origins', () => {
    // It previously used cors({ origin: true }), which reflects ANY origin
    // back with credentials:true — so an attacker's page could make
    // authenticated cross-origin calls on a logged-in user's behalf.
    expect(codeOnly).not.toMatch(/origin:\s*true/);
    expect(codeOnly).not.toMatch(/cors\(/);
  });
});
