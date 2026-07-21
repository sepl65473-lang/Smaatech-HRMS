import 'dotenv/config';
import logger from './lib/logger.js';
import { connectDB } from './db.js';
import { initFaceEngine } from './lib/faceEngine.js';
import { startDocumentExpiryScheduler } from './lib/documentExpiryJob.js';
import app from './app.js';

process.on('unhandledRejection', (err) => {
  logger.error('[server] unhandled rejection: %o', err);
});
process.on('uncaughtException', (err) => {
  logger.error('[server] uncaught exception: %o', err);
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`[server] listening on 0.0.0.0:${PORT}`);
  logger.info(`[server] Swagger API documentation available at http://localhost:${PORT}/api-docs`);

  connectDB().catch((err) => {
    logger.error('[db] connection failed: %s', err.message);
  });

  initFaceEngine().catch((err) => {
    logger.warn('[face] engine init deferred: %s', err.message);
  });

  try {
    startDocumentExpiryScheduler();
  } catch (err) {
    logger.warn('[scheduler] deferred: %s', err.message);
  }
});
