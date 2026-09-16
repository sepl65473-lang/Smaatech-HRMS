import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * These tests exist because the previous scheme passed a 100-user load test
 * while being unusable by a real 100-person office. The load script gave every
 * virtual user its own X-Forwarded-For, so the per-IP limiter was never the
 * thing under test. Everything here deliberately sends traffic from ONE
 * address, which is what an office NAT actually looks like.
 *
 * The limiters no-op under NODE_ENV=test, so this file runs them for real by
 * switching to 'production' before importing the app - the same technique
 * app.test.js uses to exercise the CORS-on-429 behaviour.
 */
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-for-rate-limits';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-for-rate-limits';
process.env.CLIENT_ORIGIN = 'https://hrms.example.com';

// Keep the numbers small so the suite stays fast, while preserving the SHAPE
// of the architecture: a per-account login cap far below the per-network one.
process.env.RL_ANON_MAX = '20';
process.env.RL_USER_MAX = '25';
process.env.RL_IP_CEILING = '100000';
process.env.RL_LOGIN_IP_MAX = '200';
process.env.RL_LOGIN_BURST_MAX = '120';
process.env.RL_LOGIN_ACCOUNT_MAX = '5';

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

const { startTestDB, stopTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const { identityKey, verifiedUserId, LIMITS } = await import('./rateLimits.js');

const OFFICE_IP = '203.0.113.50';

function tokenFor(userId) {
  return jwt.sign({ sub: userId, role: 'Employee', company: 'Acme', tv: 0 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

function asUser(userId, ip = OFFICE_IP) {
  return request(app)
    .get('/api/v1/health')
    .set('X-Forwarded-For', ip)
    .set('Authorization', `Bearer ${tokenFor(userId)}`);
}

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); process.env.NODE_ENV = originalNodeEnv; });

describe('identity key derivation', () => {
  it('keys an authenticated request by user, not by address', () => {
    const req = { headers: { authorization: `Bearer ${tokenFor('user-abc')}` }, ip: OFFICE_IP };
    expect(identityKey(req)).toBe('u:user-abc');
  });

  it('falls back to the address when there is no token', () => {
    expect(identityKey({ headers: {}, ip: OFFICE_IP })).toBe(`ip:${OFFICE_IP}`);
  });

  it('IGNORES a forged token rather than granting it a fresh bucket', () => {
    // Signed with the wrong key: an attacker must not be able to mint a new
    // identity and reset their own allowance.
    const forged = jwt.sign({ sub: 'attacker' }, 'not-the-real-secret');
    const req = { headers: { authorization: `Bearer ${forged}` }, ip: OFFICE_IP };
    expect(verifiedUserId(req)).toBeNull();
    expect(identityKey(req)).toBe(`ip:${OFFICE_IP}`);
  });

  it('collapses IPv6 to a subnet so one host cannot rotate addresses', () => {
    const a = identityKey({ headers: {}, ip: '2401:4900:8f84:1170::1' });
    const b = identityKey({ headers: {}, ip: '2401:4900:8f84:1170::99' });
    expect(a).toBe(b);
  });
});

describe('office NAT: many employees, one public address', () => {
  it('does not let one employee exhaust a colleague allowance', async () => {
    // Spend the whole per-user allowance for employee one.
    for (let i = 0; i < LIMITS.userMax + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await asUser('employee-one');
    }
    const exhausted = await asUser('employee-one');
    expect(exhausted.status).toBe(429);

    // A colleague on the SAME address must be unaffected. Under the old
    // per-IP scheme this was a 429 and was the whole bug.
    const colleague = await asUser('employee-two');
    expect(colleague.status).toBe(200);
  });

  it('gives each of 100 employees on one address their own bucket', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => asUser(`staff-${i}`)),
    );
    const rejected = results.filter((r) => r.status === 429);
    expect(rejected).toHaveLength(0);
  });
});

describe('login protection is layered, not one shared bucket', () => {
  it('allows a whole office to sign in from one address', async () => {
    // 100 DIFFERENT accounts from ONE address. The old 10-per-IP bucket made
    // this impossible; the per-account layer is what carries the security.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', OFFICE_IP)
        .send({ email: `staff-${i}@example.com`, password: 'WrongPass123' })),
    );
    const networkBlocked = results.filter((r) => r.status === 429);
    expect(networkBlocked).toHaveLength(0);
  });

  it('still stops repeated attempts against ONE account', async () => {
    const email = 'victim@example.com';
    const attempt = (ip) => request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'GuessGuess123' });

    // Rotate the source address on every attempt: the account layer must not
    // care where the guesses originate.
    for (let i = 0; i < LIMITS.loginAccountMax; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`198.51.100.${i + 1}`);
    }
    const blocked = await attempt('198.51.100.200');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('a rate-limited response still carries CORS headers', async () => {
    // Without these the browser reports a bare "Network Error" instead of the
    // real reason, which is indistinguishable from the server being down.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://hrms.example.com')
      .set('X-Forwarded-For', '198.51.100.201')
      .send({ email: 'victim@example.com', password: 'GuessGuess123' });
    expect(res.status).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBe('https://hrms.example.com');
  });
});

describe('anonymous traffic stays on the stricter per-address allowance', () => {
  it('limits unauthenticated callers by address', async () => {
    const ip = '203.0.113.99';
    const hit = () => request(app).get('/api/v1/health').set('X-Forwarded-For', ip);
    for (let i = 0; i < LIMITS.anonMax + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await hit();
    }
    const res = await hit();
    expect(res.status).toBe(429);
  });
});
