import { Router } from 'express';
import { analyzeAndPredict, recordTelemetry } from '../lib/aiPredictor.js';

const router = Router();

// GET /api/v1/ai/predict — AI/ML Predictive Traffic Forecast & Anomaly Alerting
router.get('/predict', (_req, res) => {
  const prediction = analyzeAndPredict();
  res.json(prediction);
});

// POST /api/v1/ai/telemetry — Ingest real-time metrics for AI model training / analysis
router.post('/telemetry', (req, res) => {
  const { rps, cpuLoad, memoryUsedRatio, eventLoopLagMs, errorRatePercent } = req.body || {};
  recordTelemetry({
    rps: Number(rps) || 0,
    cpuLoad: Number(cpuLoad) || 0,
    memoryUsedRatio: Number(memoryUsedRatio) || 0,
    eventLoopLagMs: Number(eventLoopLagMs) || 0,
    errorRatePercent: Number(errorRatePercent) || 0,
  });
  res.json({ status: 'ingested', timestamp: new Date().toISOString() });
});

export default router;
