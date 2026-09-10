// Server-side face detection/matching — the actual verification authority.
// The browser's own face-api.js run (src/lib/faceAuth.js) is UX-only from
// here on; a forged client can lie about a descriptor or a "matched: true"
// flag, but it can't fake what this module's own model sees in an uploaded
// photo. Runs on the WASM backend (@tensorflow/tfjs-backend-wasm) — no
// native build tools needed, validated in scripts/face-spike.js.
import path from 'node:path';
import jpeg from 'jpeg-js';
import fs from 'node:fs';

const MODELS_DIR = path.resolve(import.meta.dirname, '../../../public/models');
const WASM_DIR = path.resolve(import.meta.dirname, '../../node_modules/@tensorflow/tfjs-backend-wasm/dist/');
export const MATCH_THRESHOLD = 0.5;

let ready = null;
let tfModule = null;
let faceapiModule = null;

export function initFaceEngine() {
  if (!ready) {
    ready = (async () => {
      try {
        if (!fs.existsSync(MODELS_DIR)) {
          console.warn('[face] models directory not found at', MODELS_DIR);
          return null;
        }
        const tf = await import('@tensorflow/tfjs');
        const wasm = await import('@tensorflow/tfjs-backend-wasm');
        const faceapi = await import('@vladmandic/face-api/dist/face-api.node-wasm.js');

        wasm.setWasmPaths(WASM_DIR + path.sep);
        await tf.setBackend('wasm');
        await tf.ready();
        await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

        tfModule = tf;
        faceapiModule = faceapi;
        console.log('[face] model loaded dynamically, backend:', tf.getBackend());
        return { tf, faceapi };
      } catch (err) {
        console.warn('[face] init deferred:', err.message);
        return null;
      }
    })();
  }
  return ready;
}

function jpegBufferToTensor(buffer, tf) {
  const decoded = jpeg.decode(buffer, { useTArray: true });
  const { width, height, data } = decoded;

  if (width < 120 || height < 120) {
    return { error: 'LOW_RESOLUTION' };
  }

  // Quality & PAD variance heuristic check: compute mean intensity and variance
  let sum = 0;
  const totalPixels = width * height;
  for (let i = 0; i < data.length; i += 4) {
    // Luminance approximation: 0.299R + 0.587G + 0.114B
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
  }
  const mean = sum / totalPixels;
  let varianceSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    varianceSum += (lum - mean) ** 2;
  }
  const variance = varianceSum / totalPixels;
  if (variance < 20) {
    return { error: 'LOW_QUALITY' };
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { tensor: tf.tensor3d(rgb, [height, width, 3]) };
}

// Internal CPU-bound descriptor extraction
export async function extractDescriptorDirect(jpegBuffer) {
  const modules = await initFaceEngine();
  if (!modules || !tfModule || !faceapiModule) {
    return { error: 'ENGINE_NOT_READY' };
  }
  const prepared = jpegBufferToTensor(jpegBuffer, tfModule);
  if (prepared.error) {
    return { error: prepared.error };
  }
  const { tensor } = prepared;
  try {
    const results = await faceapiModule
      .detectAllFaces(tensor, new faceapiModule.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (results.length === 0) return { error: 'NO_FACE' };
    if (results.length > 1) return { error: 'MULTIPLE_FACES' };
    return { descriptor: Array.from(results[0].descriptor) };
  } finally {
    tfModule.dispose(tensor);
  }
}

// Offloads heavy WASM CPU calculation to a background worker thread to keep the main Express Event Loop free.
export async function extractDescriptor(jpegBuffer) {
  if (process.env.DISABLE_FACE_WORKER === 'true' || process.env.NODE_ENV === 'test') {
    return extractDescriptorDirect(jpegBuffer);
  }

  try {
    const { Worker } = await import('node:worker_threads');
    const workerPath = path.resolve(import.meta.dirname, './faceWorker.js');

    return await new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: { buffer: Array.from(jpegBuffer) },
      });

      worker.on('message', (msg) => resolve(msg));
      worker.on('error', () => resolve(extractDescriptorDirect(jpegBuffer)));
      worker.on('exit', (code) => {
        if (code !== 0) resolve(extractDescriptorDirect(jpegBuffer));
      });
    });
  } catch {
    return extractDescriptorDirect(jpegBuffer);
  }
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// Distance-based heuristic, not a calibrated probability — the UI should
// call this "match confidence", not "% certainty".
export function confidenceFromDistance(distance) {
  return Math.max(0, Math.min(100, (1 - distance / MATCH_THRESHOLD) * 100));
}

export function matchDescriptor(liveDescriptor, enrolledDescriptor) {
  const distance = euclideanDistance(liveDescriptor, enrolledDescriptor);
  return { matched: distance <= MATCH_THRESHOLD, distance, confidence: confidenceFromDistance(distance) };
}

// Shared human-readable mapping for the face-verification error codes above
// — used by every route that server-verifies a face (attendance check-in/
// out, face-login).
export function faceFailureMessage(code) {
  switch (code) {
    case 'NOT_ENROLLED': return 'Face not enrolled yet — enroll your face before checking in.';
    case 'NO_FACE': return 'No face detected in the photo — try again with better lighting, facing the camera directly.';
    case 'MULTIPLE_FACES': return 'More than one face detected — make sure only you are in frame.';
    case 'LOW_RESOLUTION': return 'Photo resolution is too low for secure biometric matching.';
    case 'LOW_QUALITY': return 'Image quality or lighting is insufficient — please capture a clear, well-lit photo.';
    case 'FACE_NOT_MATCHED': return "That doesn't match your enrolled face.";
    case 'NO_PHOTO': return 'A photo is required to check in.';
    default: return 'Face verification failed.';
  }
}
