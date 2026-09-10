import { Router } from 'express';
import mongoose from 'mongoose';
import os from 'node:os';

const router = Router();

// Event loop lag estimator
let eventLoopLag = 0;
let lastCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const delta = now - lastCheck - 1000;
  eventLoopLag = Math.max(0, delta);
  lastCheck = now;
}, 1000).unref();

const DB_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

// Health status endpoint
router.get('/health', (_req, res) => {
  const readyState = mongoose.connection.readyState;
  const dbStatus = DB_STATES[readyState] || 'unknown';
  const isHealthy = readyState === 1;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    db: dbStatus,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Detailed system telemetry metrics endpoint
router.get('/metrics', (req, res) => {
  const memory = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg();
  const dbState = mongoose.connection.readyState;

  const metricsData = {
    status: 'ok',
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    eventLoopLagMs: eventLoopLag,
    cpu: {
      cores: cpuCount,
      load1m: loadAvg[0],
      load5m: loadAvg[1],
      load15m: loadAvg[2],
    },
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      systemTotalBytes: totalMem,
      systemFreeBytes: freeMem,
      systemUsedRatio: Number(((totalMem - freeMem) / totalMem).toFixed(4)),
    },
    database: {
      status: DB_STATES[dbState] || 'unknown',
      readyState: dbState,
    },
    timestamp: new Date().toISOString(),
  };

  if (req.query.format === 'prometheus') {
    const lines = [
      '# HELP process_uptime_seconds Process uptime in seconds',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${metricsData.uptime}`,
      '# HELP process_heap_used_bytes Process heap memory used in bytes',
      '# TYPE process_heap_used_bytes gauge',
      `process_heap_used_bytes ${metricsData.memory.heapUsedBytes}`,
      '# HELP process_event_loop_lag_milliseconds Estimated event loop lag in milliseconds',
      '# TYPE process_event_loop_lag_milliseconds gauge',
      `process_event_loop_lag_milliseconds ${metricsData.eventLoopLagMs}`,
      '# HELP system_cpu_load_1m System 1-minute load average',
      '# TYPE system_cpu_load_1m gauge',
      `system_cpu_load_1m ${metricsData.cpu.load1m}`,
      '# HELP mongodb_connection_status MongoDB connection state (1 = connected)',
      '# TYPE mongodb_connection_status gauge',
      `mongodb_connection_status ${metricsData.database.readyState}`,
    ];
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(lines.join('\n'));
  }

  res.json(metricsData);
});

export default router;
