// Server-side face detection/matching — the actual verification authority.
// The browser's own face-api.js run (src/lib/faceAuth.js) is UX-only from
// here on; a forged client can lie about a descriptor or a "matched: true"
// flag, but it can't fake what this module's own model sees in an uploaded
// photo. Runs on the WASM backend (@tensorflow/tfjs-backend-wasm) — no
// native build tools needed, validated in scripts/face-spike.js.
import path from 'node:path';
import jpeg from 'jpeg-js';
import * as tf from '@tensorflow/tfjs';
import * as wasm from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';

import fs from 'node:fs';

const MODELS_DIR = path.resolve(import.meta.dirname, '../../../public/models');
const WASM_DIR = path.resolve(import.meta.dirname, '../../node_modules/@tensorflow/tfjs-backend-wasm/dist/');
export const MATCH_THRESHOLD = 0.5;

let ready = null;

export function initFaceEngine() {
  if (!ready) {
    ready = (async () => {
      try {
        if (!fs.existsSync(MODELS_DIR)) {
          console.warn('[face] models directory not found at', MODELS_DIR);
          return;
        }
        wasm.setWasmPaths(WASM_DIR + path.sep);
        await tf.setBackend('wasm');
        await tf.ready();
        await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
        console.log('[face] model loaded, backend:', tf.getBackend());
      } catch (err) {
        console.warn('[face] init deferred:', err.message);
      }
    })();
  }
  return ready;
}

function jpegBufferToTensor(buffer) {
  const { width, height, data } = jpeg.decode(buffer, { useTArray: true });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3]);
}

// Returns { descriptor: number[] } or { error: 'NO_FACE' | 'MULTIPLE_FACES' }.
export async function extractDescriptor(jpegBuffer) {
  await initFaceEngine();
  const tensor = jpegBufferToTensor(jpegBuffer);
  try {
    const results = await faceapi
      .detectAllFaces(tensor, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (results.length === 0) return { error: 'NO_FACE' };
    if (results.length > 1) return { error: 'MULTIPLE_FACES' };
    return { descriptor: Array.from(results[0].descriptor) };
  } finally {
    tf.dispose(tensor);
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
