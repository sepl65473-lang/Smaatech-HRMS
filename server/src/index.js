import 'dotenv/config';
import logger from './lib/logger.js';
import { connectDB } from './db.js';
import { initFaceEngine } from './lib/faceEngine.js';
import { startSchedulers } from './lib/jobs.js';
import { enforceStartupChecks } from './lib/startupChecks.js';
import { setupCluster } from './cluster.js';
import app from './app.js';

process.on('unhandledRejection', (err) => {
  logger.error('[server] unhandled rejection: %o', err);
});
process.on('uncaughtException', (err) => {
  logger.error('[server] uncaught exception: %o', err);
});

const PORT = process.env.PORT || 4000;

// Fail loudly here rather than serving traffic that is quietly broken: a
// missing MONGODB_URI used to surface only on the first request, and a
// placeholder JWT secret produced no signal at all.
enforceStartupChecks();

setupCluster(() => {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`[server process ${process.pid}] listening on 0.0.0.0:${PORT}`);
    logger.info(`[server] Swagger API documentation available at http://localhost:${PORT}/api-docs`);

    connectDB().catch((err) => {
      logger.error('[db] connection failed: %s', err.message);
      // A server that can never reach its database serves nothing but errors;
      // exiting lets the orchestrator restart or roll back instead of leaving
      // a permanently unhealthy instance in the load balancer.
      if (process.env.NODE_ENV === 'production') process.exitCode = 1;
    });

    initFaceEngine().catch((err) => {
      logger.warn('[face] engine init deferred: %s', err.message);
    });

    if (process.env.DISABLE_FACE_WORKER !== 'true' && process.env.NODE_ENV !== 'test') {
      import('./lib/faceWorkerPool.js')
        .then(({ warmPool }) => warmPool())
        .catch((err) => logger.warn('[facePool] warm-up deferred: %s', err.message));
    }

    try {
      startSchedulers();
    } catch (err) {
      logger.warn('[scheduler] deferred: %s', err.message);
    }
  });
});
