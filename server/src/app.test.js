import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// The rate limiters no-op under NODE_ENV=test (see app.js), so this test
// temporarily switches it off to exercise the real limiter — the only way
// to reproduce the actual bug: a rate-limited response missing CORS headers
// looks like a total network failure to a cross-origin browser client
// ("Network Error"), not the proper "too many requests" message it's
// supposed to show.
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

const ORIGIN = 'https://smaatech-hrms.vercel.app';
// The allow-list is built when app.js is first imported, so these must be set
// before that import.
process.env.CLIENT_ORIGIN = ORIGIN;
process.env.VERCEL_PREVIEW_PREFIX = 'smaatech-hrms';

const { startTestDB, stopTestDB, TEST_DB_HOOK_TIMEOUT } = await import('./test-utils/testDb.js');
const app = (await import('./app.js')).default;
const { isAllowedOrigin } = await import('./app.js');

describe('CORS headers survive rate limiting', () => {
  beforeAll(async () => {
    await startTestDB();
  }, TEST_DB_HOOK_TIMEOUT);

  afterAll(async () => {
    await stopTestDB();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('still sends Access-Control-Allow-Origin once the auth rate limit is exceeded', async () => {
    let last;
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
    }

    expect(last.status).toBe(429);
    expect(last.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});

// The previous allow-list ended in /\.vercel\.app$/, which matches EVERY app
// anyone has ever deployed to vercel.app. Combined with credentials:true, that
// let an attacker deploy a page to their own free Vercel project and make
// authenticated cross-origin calls to this API using a logged-in victim's
// cookies. These lock the boundary down.
describe('CORS origin allow-list', () => {
  it('allows the configured client origin', () => {
    expect(isAllowedOrigin(ORIGIN)).toBe(true);
    expect(isAllowedOrigin(`${ORIGIN}/`)).toBe(true);
  });

  it('allows this project own preview deployments', () => {
    expect(isAllowedOrigin('https://smaatech-hrms-abc123-team.vercel.app')).toBe(true);
  });

  it('REJECTS an unrelated vercel.app origin', () => {
    expect(isAllowedOrigin('https://attacker-site.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://evil.vercel.app')).toBe(false);
  });

  it('rejects a look-alike that merely ends in the allowed host', () => {
    expect(isAllowedOrigin('https://smaatech-hrms.vercel.app.attacker.com')).toBe(false);
    expect(isAllowedOrigin('https://notsmaatech-hrms.vercel.app')).toBe(false);
  });

  it('rejects arbitrary third-party origins', () => {
    expect(isAllowedOrigin('https://example.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(false); // production build
  });

  it('allows a request with no Origin at all (curl, server-to-server)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('does not reflect a disallowed origin back in the response header', async () => {
    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'https://attacker-site.vercel.app');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request correlation', () => {
  it('returns an X-Request-Id on every response', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-abc-123');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('ignores a malformed caller-supplied request id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id with spaces!');
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces!');
  });
});

describe('content security policy', () => {
  // CSP used to be switched off for the entire API so that Swagger UI could
  // load. These pin the replacement: strict everywhere, relaxed only on the
  // docs path.
  it('sends a locked-down policy on API responses', async () => {
    const res = await request(app).get('/api/v1/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('does not allow inline script on API responses', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
  });

  it('relaxes the policy only on the Swagger docs path', async () => {
    const res = await request(app).get('/api-docs/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    // Swagger genuinely needs inline script/style...
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    // ...but must still not be framable or able to rewrite its base URI.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});
