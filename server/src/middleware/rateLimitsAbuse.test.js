import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * ABUSE TESTS.
 *
 * Moving the general allowance from per-IP to per-user removes the office-NAT
 * failure, but it opens an obvious question: can an attacker simply mint many
 * accounts behind one address and multiply their allowance? These tests pin
 * the answer down.
 *
 * Separate file because the IP ceiling has to be set low enough to reach
 * inside a test, and doing that in rateLimits.test.js would trip the other
 * cases there.
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'abuse-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'abuse-test-refresh-secret';
process.env.CLIENT_ORIGIN = 'https://hrms.example.com';

process.env.RL_USER_MAX = '50';
process.env.RL_ANON_MAX = '50';
// Deliberately small so the backstop is reachable in a test. Production
// default is 20000.
process.env.RL_IP_CEILING = '120';
process.env.RL_FACE_USER_MAX = '5';
process.env.RL_FACE_IP_MAX = '40';

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

const { startTestDB, stopTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const { LIMITS } = await import('./rateLimits.js');

const ATTACKER_IP = '198.51.100.77';

const tokenFor = (userId) => jwt.sign(
  { sub: userId, role: 'Employee', company: 'Acme', tv: 0 },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '15m' },
);

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); process.env.NODE_ENV = originalNodeEnv; });

describe('many accounts behind one address cannot multiply the allowance', () => {
  it('still hits a per-address ceiling however many identities are used', async () => {
    // Every request uses a DIFFERENT valid user id, so the per-user limiter
    // never fires. Without the ceiling this would run forever.
    let blocked = 0;
    let sent = 0;
    for (let i = 0; i < LIMITS.ipCeiling + 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .get('/api/v1/health')
        .set('X-Forwarded-For', ATTACKER_IP)
        .set('Authorization', `Bearer ${tokenFor(`burner-${i}`)}`);
      sent += 1;
      if (res.status === 429) { blocked += 1; break; }
    }
    expect(blocked).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(LIMITS.ipCeiling + 5);
  });

  it('a legitimate user on a DIFFERENT address is unaffected by that abuse', async () => {
    const res = await request(app)
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.200')
      .set('Authorization', `Bearer ${tokenFor('honest-employee')}`);
    expect(res.status).toBe(200);
  });
});

describe('face verification abuse', () => {
  it('caps repeated face calls per user', async () => {
    const token = tokenFor('face-abuser');
    let sawLimit = false;
    for (let i = 0; i < LIMITS.faceUserMax + 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .get('/api/v1/face/status/face-abuser')
        .set('X-Forwarded-For', '203.0.113.201')
        .set('Authorization', `Bearer ${token}`);
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  it('the face limiter reports a usable error, not a bare failure', async () => {
    const token = tokenFor('face-abuser');
    const res = await request(app)
      .get('/api/v1/face/status/face-abuser')
      .set('Origin', 'https://hrms.example.com')
      .set('X-Forwarded-For', '203.0.113.201')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    // CORS must survive, or the browser shows "Network Error" instead.
    expect(res.headers['access-control-allow-origin']).toBe('https://hrms.example.com');
  });
});
