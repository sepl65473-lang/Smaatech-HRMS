import { parentPort } from 'node:worker_threads';
import { initFaceEngine, extractDescriptorDirect, extractFaceDataDirect } from './faceEngine.js';

/**
 * LONG-LIVED face worker.
 *
 * The previous version was one-shot: faceEngine.extractDescriptor() did
 * `new Worker(...)` per request, the worker processed a single photo and
 * exited. Every one of those threads had to spin up a V8 isolate, import
 * TensorFlow, initialise the WASM backend and read three model files off disk
 * before it could look at the image — seconds of work, repeated per check-in.
 * At 100 concurrent check-ins that is 100 simultaneous model loads.
 *
 * This worker loads the model ONCE and then serves tasks from the pool for the
 * lifetime of the process. See lib/faceWorkerPool.js.
 */

let ready = false;

async function boot() {
  await initFaceEngine();
  ready = true;
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'task') return;

  const { id, kind, buffer } = msg;
  try {
    if (!ready) await boot();
    const input = Buffer.from(buffer);
    const result = kind === 'faceData'
      ? await extractFaceDataDirect(input)
      : await extractDescriptorDirect(input);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'result', id, result: { error: 'WORKER_ERROR', message: err.message } });
  }
});

boot().catch((err) => {
  parentPort.postMessage({ type: 'fatal', message: err.message });
});
