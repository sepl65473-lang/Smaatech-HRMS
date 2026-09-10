import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('GET /api/v1/ai/predict & POST /api/v1/ai/telemetry', () => {
  it('ingests real-time telemetry metrics via POST /api/v1/ai/telemetry', async () => {
    const res = await request(app)
      .post('/api/v1/ai/telemetry')
      .send({ rps: 150, cpuLoad: 2.4, memoryUsedRatio: 0.65, eventLoopLagMs: 15, errorRatePercent: 0 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ingested');
  });

  it('returns predictive traffic forecast & anomaly detection analysis via GET /api/v1/ai/predict', async () => {
    const res = await request(app).get('/api/v1/ai/predict');
    expect(res.status).toBe(200);
    expect(res.body.aiModelStatus).toBe('ONLINE');
    expect(res.body.forecast).toHaveProperty('predictedPeakRps');
    expect(res.body.anomalyDetection).toHaveProperty('isAnomalous');
    expect(res.body.scalingRecommendation).toHaveProperty('action');
  });
});
