import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

/**
 * Password hashing worker.
 *
 * bcryptjs is a pure-JavaScript implementation, so every compare burns CPU on
 * whichever thread calls it. Measured on this codebase at cost factor 10:
 * 56.4 ms per compare. A hundred employees signing in at once therefore queued
 * ~5.6 seconds of main-thread work behind the event loop, which is most of the
 * ~10 s p50 login the load test reported.
 *
 * Moving it here spreads that across cores instead of serialising it, without
 * changing the algorithm, the cost factor, or the stored hash format - existing
 * hashes keep verifying exactly as before. Swapping in a native bcrypt would
 * also have worked but adds a compiled dependency to the Render build, which is
 * a deployment risk this does not carry.
 */
parentPort.on('message', async ({ id, op, plain, hash, rounds }) => {
  try {
    const result = op === 'hash'
      ? await bcrypt.hash(plain, rounds)
      : await bcrypt.compare(plain, hash);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});

parentPort.postMessage({ type: 'ready' });
