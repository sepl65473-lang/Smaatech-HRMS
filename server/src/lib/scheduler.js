import cluster from 'node:cluster';
import cron from 'node-cron';
import logger from './logger.js';

/**
 * Single owner for every cron schedule in the process.
 *
 * The problem this fixes: index.js called startWorkerCallback() for EVERY
 * clustered worker, and that callback started both schedulers. With
 * ENABLE_CLUSTER=true and 8 cores, the nightly attendance job and the
 * document-expiry job each ran 8 times at midnight — 8 concurrent bulk writes
 * over the same employees, and 8 copies of every absence and expiry email to
 * the same person. In-memory state (idempotency keys, QR tokens, the settings
 * cache, liveness challenges) is likewise per-worker, so a request handled by
 * a different worker than the one that issued a token does not see it.
 *
 * Two guards:
 *   1. Only ONE process may run schedulers. Under clustering that is worker 1
 *      (or whichever the operator pins with SCHEDULER_WORKER_ID); a single
 *      unclustered process is always the owner.
 *   2. RUN_SCHEDULERS=false switches them off entirely, for a deployment where
 *      cron is owned by a separate worker service or the platform itself.
 */
export function isSchedulerOwner() {
  if (process.env.RUN_SCHEDULERS === 'false') return false;
  if (!cluster.isWorker) return true; // single, unclustered process
  const pinned = Number(process.env.SCHEDULER_WORKER_ID || 1);
  return cluster.worker?.id === pinned;
}

const registered = [];

/**
 * Registers a cron job, but only in the owning process.
 *
 * `timezone` is explicit: these jobs are dated against IST (lib/dateUtils.js
 * pins todayISO() to Asia/Kolkata), so a server running in UTC would otherwise
 * fire "midnight" 5h30m away from the business day the job reasons about,
 * producing rows dated to the wrong day.
 */
export function scheduleJob(name, expression, task, { timezone = 'Asia/Kolkata' } = {}) {
  if (!isSchedulerOwner()) {
    logger.info('[scheduler] "%s" not started in this process (not the scheduler owner).', name);
    return null;
  }
  if (!cron.validate(expression)) {
    logger.error('[scheduler] "%s" has an invalid cron expression: %s', name, expression);
    return null;
  }

  let running = false;
  const job = cron.schedule(expression, async () => {
    // A long job must not overlap its own next tick.
    if (running) {
      logger.warn('[scheduler] "%s" is still running from the previous tick — skipping.', name);
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      await task();
      logger.info('[scheduler] "%s" finished in %dms.', name, Date.now() - startedAt);
    } catch (err) {
      logger.error('[scheduler] "%s" failed: %o', name, err);
    } finally {
      running = false;
    }
  }, { timezone });

  registered.push({ name, expression, timezone });
  logger.info('[scheduler] "%s" scheduled (%s, %s).', name, expression, timezone);
  return job;
}

export function registeredJobs() {
  return [...registered];
}
