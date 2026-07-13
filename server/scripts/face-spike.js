// De-risking spike (not wired into the app). Proves the server can load the
// existing face-api.js model weights and run detection/descriptor extraction
// on a plain Node process, WITHOUT @tensorflow/tfjs-node (native build tools
// aren't available on this machine) and WITHOUT the `canvas` package —
// using the WASM backend instead (@tensorflow/tfjs-backend-wasm, prebuilt
// .wasm binaries, no compiler needed) via @vladmandic/face-api's dedicated
// node-wasm build (the original face-api.js is unmaintained and bundles an
// incompatible old TensorFlow.js internally — this fork fixes that).
//
// Run with: node scripts/face-spike.js <photoA1.jpg> <photoA2.jpg> [photoB.jpg]
//   photoA1/photoA2 = two photos of the SAME person (expect a close match)
//   photoB          = a photo of a DIFFERENT person (expect no match)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import * as tf from '@tensorflow/tfjs';
import * as wasm from '@tensorflow/tfjs-backend-wasm';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';

const MODELS_DIR = path.resolve(import.meta.dirname, '../../public/models');
const WASM_DIR = path.resolve(import.meta.dirname, '../node_modules/@tensorflow/tfjs-backend-wasm/dist/');

function loadImageAsTensor(filePath) {
  const buffer = fs.readFileSync(filePath);
  const { width, height, data } = jpeg.decode(buffer, { useTArray: true });
  // jpeg-js gives RGBA; face-api's nets expect RGB.
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3]);
}

async function descriptorFor(filePath) {
  const tensor = loadImageAsTensor(filePath);
  try {
    const result = await faceapi
      .detectSingleFace(tensor, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? result.descriptor : null;
  } finally {
    tf.dispose(tensor);
  }
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

async function main() {
  const [pathA1, pathA2, pathB] = process.argv.slice(2);
  if (!pathA1 || !pathA2) {
    console.log('Usage: node scripts/face-spike.js <sameA1.jpg> <sameA2.jpg> [different.jpg]');
    process.exit(1);
  }

  wasm.setWasmPaths(WASM_DIR + path.sep);
  await tf.setBackend('wasm');
  await tf.ready();
  console.log('TensorFlow.js backend:', tf.getBackend());

  console.log('Loading models from', MODELS_DIR);
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  console.log('Models loaded OK.');

  console.log('\nExtracting descriptor for', pathA1);
  const descA1 = await descriptorFor(pathA1);
  console.log(descA1 ? `OK — 128-d descriptor` : 'NO FACE DETECTED');

  console.log('Extracting descriptor for', pathA2);
  const descA2 = await descriptorFor(pathA2);
  console.log(descA2 ? `OK — 128-d descriptor` : 'NO FACE DETECTED');

  if (descA1 && descA2) {
    const d = distance(descA1, descA2);
    console.log(`\nDistance between the two "same person" photos: ${d.toFixed(4)} (threshold 0.5) -> ${d <= 0.5 ? 'MATCH (correct)' : 'NO MATCH (WRONG)'}`);
  }

  if (pathB) {
    console.log('\nExtracting descriptor for', pathB, '(different person)');
    const descB = await descriptorFor(pathB);
    console.log(descB ? `OK — 128-d descriptor` : 'NO FACE DETECTED');
    if (descA1 && descB) {
      const d = distance(descA1, descB);
      console.log(`Distance between person A and person B: ${d.toFixed(4)} (threshold 0.5) -> ${d > 0.5 ? 'NO MATCH (correct)' : 'MATCH (WRONG)'}`);
    }
  }
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err);
  process.exit(1);
});
