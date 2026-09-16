import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import logger from './logger.js';

/**
 * Bounded pool of long-lived face-extraction workers.
 *
 * WHY THIS EXISTS — measured, not assumed. scripts/concurrency100.js drove 100
 * simultaneous login + face check-in flows against the real server and every
 * request succeeded, but check-in p50 was 19.2 SECONDS. Two causes, both
 * CPU-bound on a single-threaded runtime:
 *
 *   1. face descriptor extraction runs ~110-350ms of pure CPU per photo, and
 *      100 of them queued behind one event loop;
 *   2. the previous worker path created a NEW Worker per request, so each one
 *      re-imported TensorFlow and re-read three model files from disk before
 *      doing any work — strictly worse than staying in-process.
 *
 * This pool fixes both: workers are created once, load the model once, and
 * then take tasks from a queue. Extraction moves OFF the request event loop,
 * so the server keeps answering other routes while faces are processed, and
 * concurrency is bounded so a burst cannot spawn unbounded threads.
 *
 * Sizing: one worker per spare core, capped. More workers than cores does not
 * add throughput for CPU-bound work, it just adds context switching.
 */
const WORKER_PATH = path.resolve(import.meta.dirname, './faceWorker.js');

// Sizing is MEASURED, not guessed. Face extraction costs ~196ms of pure CPU
// per photo (320x240, TinyFaceDetector + landmarks + recognition net), so 100
// simultaneous check-ins are ~19.6 CPU-seconds — 75% of the total work in a
// peak check-in burst, with bcrypt making up the rest.
//
// It is CPU-bound, so throughput scales with WORKERS, up to the core count.
// An earlier version hard-capped this at 4, which on a 16-core host left 75%
// of the machine idle while employees waited. The cap now follows the host,
// with an upper bound so a very large box does not spawn dozens of
// TensorFlow instances (each worker holds its own model in memory).
const HOST_PARALLELISM = os.availableParallelism?.() || os.cpus().length;

// CLUSTER-AWARE. getPool() is per-PROCESS, so under `ENABLE_CLUSTER` every
// cluster worker builds its own pool. Sizing each one to the whole host would
// oversubscribe badly — 8 cluster workers x 15 face workers is 120 threads,
// each holding its own TensorFlow instance, on a 16-core box. The host budget
// is divided by the number of cluster workers instead.
const CLUSTER_WORKERS = Number(process.env.WEB_CONCURRENCY || 0)
  || (process.env.ENABLE_CLUSTER === 'true' ? HOST_PARALLELISM : 1);

const POOL_SIZE = Math.max(1, Math.min(
  Number(process.env.FACE_WORKER_POOL_SIZE || 0)
    || Math.max(1, Math.floor((HOST_PARALLELISM - 1) / Math.max(1, CLUSTER_WORKERS))),
  Number(process.env.FACE_WORKER_POOL_MAX || 8),
));

// A queued photo that will never be processed in time is better rejected than
// left to pile up: the client has already given up, and holding the buffer
// costs memory that the requests still in flight need.
const QUEUE_TIMEOUT_MS = Number(process.env.FACE_QUEUE_TIMEOUT_MS || 20000);
const MAX_QUEUE = Number(process.env.FACE_MAX_QUEUE || 200);

let pool = null;

function createWorker(state) {
  const worker = new Worker(WORKER_PATH);
  const entry = { worker, busy: false, ready: false, current: null };

  worker.on('message', (msg) => {
    if (msg?.type === 'ready') {
      entry.ready = true;
      logger.info('[facePool] worker ready (%d/%d)', state.workers.filter((w) => w.ready).length, POOL_SIZE);
      drain(state);
      return;
    }
    if (msg?.type === 'result' && entry.current) {
      const { resolve, timer } = entry.current;
      clearTimeout(timer);
      entry.current = null;
      entry.busy = false;
      resolve(msg.result);
      drain(state);
    }
  });

  worker.on('error', (err) => {
    logger.error('[facePool] worker error: %s', err.message);
    if (entry.current) {
      const { resolve, timer } = entry.current;
      clearTimeout(timer);
      entry.current = null;
      resolve({ error: 'ENGINE_NOT_READY' });
    }
    entry.busy = false;
    replaceWorker(state, entry);
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      logger.warn('[facePool] worker exited with code %d — replacing', code);
      replaceWorker(state, entry);
    }
  });

  return entry;
}

function replaceWorker(state, dead) {
  const idx = state.workers.indexOf(dead);
  if (idx === -1) return;
  state.workers.splice(idx, 1);
  // Only replace while the pool is still meant to be running.
  if (!state.stopped) state.workers.push(createWorker(state));
  drain(state);
}

function drain(state) {
  for (const entry of state.workers) {
    if (entry.busy || !entry.ready) continue;
    const task = state.queue.shift();
    if (!task) return;

    entry.busy = true;
    const timer = setTimeout(() => {
      if (entry.current === task.handle) {
        entry.current = null;
        entry.busy = false;
        task.handle.resolve({ error: 'ENGINE_TIMEOUT' });
        // A worker that blew its budget may be wedged; recycle it.
        entry.worker.terminate().catch(() => {});
      }
    }, QUEUE_TIMEOUT_MS);

    task.handle.timer = timer;
    entry.current = task.handle;
    entry.worker.postMessage(
      { type: 'task', id: task.id, kind: task.kind, buffer: task.buffer },
      // Transfer the underlying memory instead of structured-cloning a 5MB
      // JPEG into the worker: a copy per request is real, avoidable pressure.
      [task.buffer.buffer],
    );
  }
}

function getPool() {
  if (!pool) {
    pool = { workers: [], queue: [], nextId: 1, stopped: false };
    for (let i = 0; i < POOL_SIZE; i += 1) pool.workers.push(createWorker(pool));
    logger.info('[facePool] started %d face worker(s)', POOL_SIZE);
  }
  return pool;
}

/**
 * Runs one extraction on the pool.
 * @param {Buffer} jpegBuffer
 * @param {'descriptor'|'faceData'} kind
 */
export function runInPool(jpegBuffer, kind = 'descriptor') {
  const state = getPool();

  if (state.queue.length >= MAX_QUEUE) {
    // Shed load rather than accept work that cannot be served in time.
    return Promise.resolve({ error: 'ENGINE_BUSY' });
  }

  return new Promise((resolve) => {
    const handle = { resolve, timer: null };
    // A copy the pool owns, so transferring its memory cannot detach a buffer
    // the caller still needs.
    const owned = Uint8Array.from(jpegBuffer);
    state.queue.push({ id: state.nextId++, kind, buffer: owned, handle });
    drain(state);
  });
}

export function poolStats() {
  if (!pool) return { started: false, size: POOL_SIZE, ready: 0, busy: 0, queued: 0 };
  return {
    started: true,
    size: POOL_SIZE,
    ready: pool.workers.filter((w) => w.ready).length,
    busy: pool.workers.filter((w) => w.busy).length,
    queued: pool.queue.length,
  };
}

export async function shutdownPool() {
  if (!pool) return;
  pool.stopped = true;
  await Promise.all(pool.workers.map((w) => w.worker.terminate().catch(() => {})));
  pool = null;
}

export { POOL_SIZE };
