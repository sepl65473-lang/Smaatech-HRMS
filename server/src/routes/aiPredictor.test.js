// The AI predictor endpoints were completely unauthenticated: anyone on the
// internet could read host CPU/memory/event-loop telemetry from
// GET /api/v1/ai/predict, and — worse — POST arbitrary samples into the
// rolling window the Z-score anomaly detector reasons over, flattening its
// baseline until a genuine incident no longer registered as anomalous.
//
// These tests now assert BOTH halves: the endpoints still work for a
// legitimate caller, and they are closed to an anonymous one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.METRICS_TOKEN = 'test-metrics-token';

const app = (await import('../app.js')).default;

const TOKEN_HEADER = { 'X-Metrics-Token': 'test-metrics-token' };

describe('AI predictor endpoints require internal access', () => {
  it('rejects an anonymous telemetry push', async () => {
    const res = await request(app)
      .post('/api/v1/ai/telemetry')
      .send({ rps: 999999, cpuLoad: 99, memoryUsedRatio: 1, eventLoopLagMs: 9999, errorRatePercent: 100 });
    expect(res.status).toBe(401);
  });

  it('rejects an anonymous forecast read', async () => {
    const res = await request(app).get('/api/v1/ai/predict');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong scrape token', async () => {
    const res = await request(app)
      .get('/api/v1/ai/predict')
      .set('X-Metrics-Token', 'not-the-token');
    expect(res.status).toBe(401);
  });
});

describe('AI predictor endpoints with a valid scrape token', () => {
  it('ingests real-time telemetry metrics via POST /api/v1/ai/telemetry', async () => {
    const res = await request(app)
      .post('/api/v1/ai/telemetry')
      .set(TOKEN_HEADER)
      .send({ rps: 150, cpuLoad: 2.4, memoryUsedRatio: 0.65, eventLoopLagMs: 15, errorRatePercent: 0 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ingested');
  });

  it('returns predictive traffic forecast & anomaly detection analysis via GET /api/v1/ai/predict', async () => {
    const res = await request(app).get('/api/v1/ai/predict').set(TOKEN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.aiModelStatus).toBe('ONLINE');
    expect(res.body.forecast).toHaveProperty('predictedPeakRps');
    expect(res.body.anomalyDetection).toHaveProperty('isAnomalous');
    expect(res.body.scalingRecommendation).toHaveProperty('action');
  });

  it('clamps out-of-range telemetry so a poisoned sample cannot skew the baseline', async () => {
    // Infinity/NaN/absurd values previously flowed straight into the rolling
    // window, corrupting the mean and standard deviation for every later read.
    const res = await request(app)
      .post('/api/v1/ai/telemetry')
      .set(TOKEN_HEADER)
      .send({ rps: 1e30, cpuLoad: 'NaN', memoryUsedRatio: 500, eventLoopLagMs: -5, errorRatePercent: 1e9 });
    expect(res.status).toBe(200);

    const predict = await request(app).get('/api/v1/ai/predict').set(TOKEN_HEADER);
    expect(predict.status).toBe(200);
    expect(Number.isFinite(predict.body.forecast.predictedPeakRps)).toBe(true);
  });
});
