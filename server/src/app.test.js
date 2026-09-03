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

const { startTestDB, stopTestDB, TEST_DB_HOOK_TIMEOUT } = await import('./test-utils/testDb.js');
const app = (await import('./app.js')).default;

const ORIGIN = 'https://smaatech-hrms.vercel.app';

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
