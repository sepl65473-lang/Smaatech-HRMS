import logger from './logger.js';

// Executes large collection tasks in non-blocking chunked batches.
// YIELDS event loop CPU control between batches (setTimeout 10ms pause)
// so concurrent REST API requests experience ZERO latency spikes.
export async function processInNonBlockingBatches(items, batchSize, processFn) {
  if (!Array.isArray(items) || items.length === 0) return { processed: 0, errors: 0 };

  const total = items.length;
  const chunkSize = Math.max(1, batchSize || 250);
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    try {
      // eslint-disable-next-line no-await-in-loop
      await processFn(chunk, i);
      processed += chunk.length;
    } catch (err) {
      errors += chunk.length;
      logger.error('[JobQueue Batch Error] Failed processing chunk starting at index %d: %o', i, err);
    }

    // Yield event loop control back to Node.js HTTP server to handle incoming user requests
    if (i + chunkSize < total) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  }

  return { processed, errors };
}

// Background task wrapper to run asynchronous tasks safely without blocking callers
export function runTaskInBackground(taskName, taskFn) {
  setImmediate(async () => {
    try {
      logger.info('[JobQueue] Starting background task: %s', taskName);
      await taskFn();
      logger.info('[JobQueue] Completed background task: %s', taskName);
    } catch (err) {
      logger.error('[JobQueue] Error executing background task %s: %o', taskName, err);
    }
  });
}
