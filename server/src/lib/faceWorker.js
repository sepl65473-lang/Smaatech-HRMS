import { parentPort, workerData } from 'node:worker_threads';
import { extractDescriptorDirect } from './faceEngine.js';

async function runWorkerTask() {
  try {
    const { buffer } = workerData || {};
    if (!buffer) {
      parentPort.postMessage({ error: 'NO_PHOTO' });
      return;
    }
    const result = await extractDescriptorDirect(Buffer.from(buffer));
    parentPort.postMessage(result);
  } catch (err) {
    parentPort.postMessage({ error: 'WORKER_ERROR', message: err.message });
  }
}

runWorkerTask();
