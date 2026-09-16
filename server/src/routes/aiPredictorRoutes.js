import { Router } from 'express';
import { analyzeAndPredict, recordTelemetry } from '../lib/aiPredictor.js';
import { requireInternalAccess } from '../middleware/internalAuth.js';

const router = Router();

// Both routes below were entirely unauthenticated. /predict leaked host CPU,
// memory and event-loop telemetry to anonymous callers; /telemetry let anyone
// push samples into the rolling window the anomaly detector reasons over,
// poisoning its baseline until real incidents stopped registering.
router.use(requireInternalAccess);

// GET /api/v1/ai/predict — AI/ML Predictive Traffic Forecast & Anomaly Alerting
router.get('/predict', (_req, res) => {
  const prediction = analyzeAndPredict();
  res.json(prediction);
});

// POST /api/v1/ai/telemetry — Ingest real-time metrics for AI model training / analysis
router.post('/telemetry', (req, res) => {
  const { rps, cpuLoad, memoryUsedRatio, eventLoopLagMs, errorRatePercent } = req.body || {};
  // Clamp every sample: an out-of-range value (NaN, Infinity, 1e308) skews the
  // mean and standard deviation the Z-score anomaly check depends on.
  const clamp = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max);
  recordTelemetry({
    rps: clamp(rps, 1e6),
    cpuLoad: clamp(cpuLoad, 1024),
    memoryUsedRatio: clamp(memoryUsedRatio, 1),
    eventLoopLagMs: clamp(eventLoopLagMs, 60000),
    errorRatePercent: clamp(errorRatePercent, 100),
  });
  res.json({ status: 'ingested', timestamp: new Date().toISOString() });
});

export default router;
