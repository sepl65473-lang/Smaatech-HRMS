import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('GET /api/v1/health & /api/v1/metrics', () => {
  it('returns health status payload with status 200 or 503 depending on DB state', async () => {
    const res = await request(app).get('/api/v1/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('returns JSON system metrics telemetry via /api/v1/metrics', async () => {
    const res = await request(app).get('/api/v1/metrics');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.cpu).toHaveProperty('cores');
    expect(res.body.memory).toHaveProperty('heapUsedBytes');
    expect(res.body.database).toHaveProperty('status');
  });

  it('returns Prometheus gauge format text via /api/v1/metrics?format=prometheus', async () => {
    const res = await request(app).get('/api/v1/metrics?format=prometheus');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_uptime_seconds');
    expect(res.text).toContain('process_heap_used_bytes');
  });
});
