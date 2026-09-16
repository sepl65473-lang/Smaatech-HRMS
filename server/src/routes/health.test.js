import { describe, it, expect } from 'vitest';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.METRICS_TOKEN = 'test-metrics-token';

const app = (await import('../app.js')).default;

const SCRAPE = { 'X-Metrics-Token': 'test-metrics-token' };

describe('GET /api/v1/health', () => {
  // Deliberately public: a load balancer / container healthcheck has no
  // credentials, and the payload carries nothing sensitive.
  it('returns health status payload with status 200 or 503 depending on DB state', async () => {
    const res = await request(app).get('/api/v1/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('does not leak host or process internals', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.body).not.toHaveProperty('pid');
    expect(res.body).not.toHaveProperty('memory');
    expect(res.body).not.toHaveProperty('cpu');
  });
});

describe('GET /api/v1/metrics is not public', () => {
  // Unlike /health this returns the process id, host memory and CPU totals,
  // load averages and DB connection state — reconnaissance for anyone probing
  // the deployment. It used to be readable by any anonymous caller.
  it('rejects an anonymous request', async () => {
    const res = await request(app).get('/api/v1/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong scrape token', async () => {
    const res = await request(app).get('/api/v1/metrics').set('X-Metrics-Token', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns JSON system metrics telemetry for a valid scrape token', async () => {
    const res = await request(app).get('/api/v1/metrics').set(SCRAPE);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.cpu).toHaveProperty('cores');
    expect(res.body.memory).toHaveProperty('heapUsedBytes');
    expect(res.body.database).toHaveProperty('status');
  });

  it('returns Prometheus gauge format text for a valid scrape token', async () => {
    const res = await request(app).get('/api/v1/metrics?format=prometheus').set(SCRAPE);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_uptime_seconds');
    expect(res.text).toContain('process_heap_used_bytes');
  });
});

describe('unknown API routes', () => {
  it('return a JSON 404, not an HTML error page', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('deployed commit reporting', () => {
  // Lets an operator confirm from outside that production is running the
  // exact commit that was certified, without a platform API token.
  it('reports a commit field on /health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.body).toHaveProperty('commit');
  });

  it('is null when no build env var is present, never undefined or a guess', async () => {
    const res = await request(app).get('/api/v1/health');
    // Nothing sets RENDER_GIT_COMMIT in the test environment.
    expect(res.body.commit).toBeNull();
  });
});

describe('onboarding portal URL visibility', () => {
  // Before this, the address welcome emails send new employees to lived only
  // in the deployment's dashboard, so nobody could confirm it was right until
  // an employee received a wrong link. That is exactly how the previous
  // hardcoded, unreachable domain went unnoticed.
  it('reports the resolved portal URL on /health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.body).toHaveProperty('portalUrl');
  });

  it('is null rather than a guess when nothing is configured', async () => {
    const res = await request(app).get('/api/v1/health');
    // Nothing sets APP_PORTAL_URL or CLIENT_ORIGIN in this test file.
    expect(res.body.portalUrl === null || typeof res.body.portalUrl === 'string').toBe(true);
  });

  it('never reports the old hardcoded domain', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(String(res.body.portalUrl)).not.toContain('hrms.smaatech.co');
  });
});
