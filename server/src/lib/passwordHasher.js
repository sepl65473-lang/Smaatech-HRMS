import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import logger from './logger.js';

/**
 * Bounded worker pool for password hashing.
 *
 * WHY: bcryptjs is pure JavaScript, so a compare costs real main-thread CPU -
 * measured at 56.4 ms here. Under a shift-change rush that work serialises
 * behind the event loop and dominates login latency, while also delaying every
 * unrelated request on the same process.
 *
 * WHAT THIS IS NOT: a way to make hashing cheaper. The cost factor is
 * deliberately unchanged, because lowering it would trade a real security
 * property for a latency number. This only stops that cost from monopolising
 * one thread.
 *
 * SAFETY: every failure path falls back to hashing in-process. A broken or
 * unavailable pool must never be able to fail a login open or closed - it just
 * costs the old latency. The pool is bounded and the queue is capped, so a
 * burst cannot spawn threads without limit or grow memory without limit.
 */
const WORKER_PATH = path.resolve(import.meta.dirname, './hashWorker.js');

const HOST_PARALLELISM = os.availableParallelism?.() || os.cpus().length;
const CLUSTER_WORKERS = Number(process.env.WEB_CONCURRENCY || 0)
  || (process.env.ENABLE_CLUSTER === 'true' ? HOST_PARALLELISM : 1);

const POOL_SIZE = Math.max(1, Math.min(
  Number(process.env.HASH_WORKER_POOL_SIZE || 0)
    || Math.max(1, Math.floor((HOST_PARALLELISM - 1) / Math.max(1, CLUSTER_WORKERS))),
  Number(process.env.HASH_WORKER_POOL_MAX || 6),
));

const MAX_QUEUE = Number(process.env.HASH_MAX_QUEUE || 500);
const TASK_TIMEOUT_MS = Number(process.env.HASH_TASK_TIMEOUT_MS || 15000);

// Disabled under test so the suite does not pay thread-startup cost on every
// file, and so a worker cannot outlive a test run.
const DISABLED = process.env.DISABLE_HASH_WORKER === 'true' || process.env.NODE_ENV === 'test';

let state = null;
let nextId = 1;

function spawn(s) {
  const worker = new Worker(WORKER_PATH);
  const entry = { worker, busy: false, current: null };

  worker.on('message', (msg) => {
    if (msg?.type === 'ready') return;
    const task = entry.current;
    if (!task || msg.id !== task.id) return;
    clearTimeout(task.timer);
    entry.current = null;
    entry.busy = false;
    if (msg.ok) task.resolve(msg.result);
    else task.reject(new Error(msg.error || 'hash worker failed'));
    drain(s);
  });

  const fail = (err) => {
    logger.warn('[hashPool] worker problem: %s', err?.message || err);
    if (entry.current) {
      clearTimeout(entry.current.timer);
      entry.current.reject(new Error('hash worker unavailable'));
      entry.current = null;
    }
    entry.busy = false;
    const idx = s.workers.indexOf(entry);
    if (idx !== -1) s.workers.splice(idx, 1);
    if (!s.stopped && s.workers.length < POOL_SIZE) s.workers.push(spawn(s));
    drain(s);
  };

  worker.on('error', fail);
  worker.on('exit', (code) => { if (code !== 0 && !s.stopped) fail(new Error(`exit ${code}`)); });
  return entry;
}

function getPool() {
  if (!state) {
    state = { workers: [], queue: [], stopped: false };
    for (let i = 0; i < POOL_SIZE; i += 1) state.workers.push(spawn(state));
    logger.info('[hashPool] %d password-hash worker(s) started', POOL_SIZE);
  }
  return state;
}

function drain(s) {
  while (s.queue.length) {
    const free = s.workers.find((w) => !w.busy);
    if (!free) return;
    const task = s.queue.shift();
    free.busy = true;
    free.current = task;
    task.timer = setTimeout(() => {
      if (free.current === task) {
        free.current = null;
        free.busy = false;
        task.reject(new Error('hash worker timeout'));
      }
    }, TASK_TIMEOUT_MS);
    free.worker.postMessage({ id: task.id, op: task.op, plain: task.plain, hash: task.hash, rounds: task.rounds });
  }
}

function runInPool(payload) {
  const s = getPool();
  if (!s.workers.length) return Promise.reject(new Error('no hash workers'));
  if (s.queue.length >= MAX_QUEUE) return Promise.reject(new Error('hash queue full'));
  return new Promise((resolve, reject) => {
    s.queue.push({ id: nextId++, ...payload, resolve, reject });
    drain(s);
  });
}

/** bcrypt.compare, off the request thread where possible. */
export async function comparePassword(plain, hash) {
  if (!hash) return false;
  if (DISABLED) return bcrypt.compare(plain || '', hash);
  try {
    return await runInPool({ op: 'compare', plain: plain || '', hash });
  } catch (err) {
    // Never let pool trouble decide an authentication outcome.
    logger.warn('[hashPool] falling back in-process for compare: %s', err.message);
    return bcrypt.compare(plain || '', hash);
  }
}

/** bcrypt.hash, off the request thread where possible. */
export async function hashPassword(plain, rounds = 10) {
  if (DISABLED) return bcrypt.hash(plain, rounds);
  try {
    return await runInPool({ op: 'hash', plain, rounds });
  } catch (err) {
    logger.warn('[hashPool] falling back in-process for hash: %s', err.message);
    return bcrypt.hash(plain, rounds);
  }
}

export function poolStats() {
  if (!state) return { size: 0, busy: 0, queued: 0, configured: POOL_SIZE };
  return {
    size: state.workers.length,
    busy: state.workers.filter((w) => w.busy).length,
    queued: state.queue.length,
    configured: POOL_SIZE,
  };
}

export async function stopHashPool() {
  if (!state) return;
  state.stopped = true;
  await Promise.all(state.workers.map((w) => w.worker.terminate()));
  state = null;
}
