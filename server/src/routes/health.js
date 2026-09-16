import { Router } from 'express';
import mongoose from 'mongoose';
import os from 'node:os';
import { requireInternalAccess } from '../middleware/internalAuth.js';
import { poolStats as facePoolStats } from '../lib/faceWorkerPool.js';
import { lastBackupStatus } from '../lib/backupJob.js';
import { portalUrl } from '../lib/portalUrl.js';

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

// The deployed commit, so "is production actually running the release we
// certified?" is answerable from outside without a platform API token.
// Render sets RENDER_GIT_COMMIT and Vercel sets VERCEL_GIT_COMMIT_SHA on every
// build; neither is secret, and only the short hash is exposed.
const DEPLOYED_COMMIT = (
  process.env.RENDER_GIT_COMMIT
  || process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GIT_COMMIT
  || ''
).slice(0, 7) || null;

// The address every onboarding email will send a new employee to.
//
// This is NOT decoration. It is derived from APP_PORTAL_URL/CLIENT_ORIGIN, both
// of which live in the deployment's own dashboard and cannot be read from
// outside - so before this, nobody could confirm what link employees would
// actually receive until one of them received a wrong one. The template
// previously carried a hardcoded domain that was verified unreachable, which is
// exactly that failure. It is a public URL, not a secret.
//
// null means no address is configured, in which case the welcome email omits
// the sign-in button rather than shipping a dead link.

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
    commit: DEPLOYED_COMMIT,
    portalUrl: portalUrl(),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Detailed system telemetry. Deliberately NOT public, unlike /health above:
// this returns the process id, host memory/CPU totals, load averages and
// database connection state — useful reconnaissance for anyone probing the
// deployment, and previously readable by any anonymous caller.
router.get('/metrics', requireInternalAccess, (req, res) => {
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
    // Face extraction is the most expensive thing this server does
    // (~110-350ms CPU per photo). A growing queue here is the leading
    // indicator of a check-in backlog at shift change — see
    // lib/faceWorkerPool.js and scripts/concurrency100.js.
    faceWorkers: facePoolStats(),
    // A backup that has silently been failing for a fortnight is discovered at
    // the worst possible moment. Reporting it here means monitoring can see it.
    backup: lastBackupStatus(),
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
      '# HELP face_worker_queue_depth Photos waiting for face extraction',
      '# TYPE face_worker_queue_depth gauge',
      `face_worker_queue_depth ${metricsData.faceWorkers.queued}`,
      '# HELP face_worker_busy Face workers currently processing',
      '# TYPE face_worker_busy gauge',
      `face_worker_busy ${metricsData.faceWorkers.busy}`,
    ];
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(lines.join('\n'));
  }

  res.json(metricsData);
});

export default router;
