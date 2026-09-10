import cluster from 'node:cluster';
import os from 'node:os';
import logger from './lib/logger.js';

export function setupCluster(startWorkerCallback) {
  const isClusterEnabled = process.env.ENABLE_CLUSTER === 'true' || Boolean(process.env.WEB_CONCURRENCY);

  if (isClusterEnabled && cluster.isPrimary) {
    const numCPUs = process.env.WEB_CONCURRENCY
      ? parseInt(process.env.WEB_CONCURRENCY, 10)
      : (os.availableParallelism?.() || os.cpus().length);

    logger.info(`[cluster] Primary process ${process.pid} is running. Forking ${numCPUs} worker(s)...`);

    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.warn(`[cluster] Worker process ${worker.process.pid} exited (code: ${code}, signal: ${signal}). Respawning...`);
      cluster.fork();
    });
  } else {
    // Single process mode or worker process entry
    startWorkerCallback();
  }
}
