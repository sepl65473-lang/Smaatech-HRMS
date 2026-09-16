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

// TinyFaceDetector input resolution.
//
// MEASURED, across every real capture in uploads/: 320 is ~35% faster than the
// 416 default (det416 54-105ms -> det320 30-70ms) and produces a BYTE-IDENTICAL
// descriptor — euclidean drift 0.0000 on every photo where a face was found,
// and the same no-face outcome on every photo where none was. The descriptor
// comes from the aligned crop, so detector resolution does not change it once
// the same face box is found.
//
// This does not weaken verification. A lower resolution can only make the
// detector MISS a small or distant face, which produces NO_FACE — a rejection.
// It cannot cause a false ACCEPT, because matching still runs at full
// precision against the enrolled template with the same 0.5 threshold.
// Raise it with FACE_DETECTOR_INPUT_SIZE if users are being asked to retry.
const DETECTOR_INPUT_SIZE = Number(process.env.FACE_DETECTOR_INPUT_SIZE || 320);

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

// The upload middleware advertises JPEG/PNG/WebP, but jpeg-js decodes only
// JPEG — a genuine PNG upload previously threw "SOI not found" OUTSIDE the
// try block below and surfaced as an opaque 500. Check the actual magic bytes
// and return a proper error code the route can turn into a 400.
function isJpeg(buffer) {
  return buffer && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

// Quality/exposure statistics, used both to reject unusable captures and, in
// lib/liveness.js, to compare consecutive frames.
export function imageStatsOf(data, width, height) {
  let sum = 0;
  const totalPixels = width * height;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const mean = sum / totalPixels;
  let varianceSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    varianceSum += (lum - mean) ** 2;
  }
  return { mean, variance: varianceSum / totalPixels, width, height };
}

function decodeJpeg(buffer) {
  if (!isJpeg(buffer)) return { error: 'UNSUPPORTED_FORMAT' };
  let decoded;
  try {
    decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 64 });
  } catch {
    return { error: 'UNSUPPORTED_FORMAT' };
  }
  const { width, height, data } = decoded;
  if (!width || !height) return { error: 'UNSUPPORTED_FORMAT' };
  if (width < 120 || height < 120) return { error: 'LOW_RESOLUTION' };
  // Guard against a decompression-bomb JPEG exhausting the process.
  if (width * height > 40_000_000) return { error: 'IMAGE_TOO_LARGE' };

  const stats = imageStatsOf(data, width, height);
  // NOT a liveness check — this only rejects a flat/blank/obscured frame
  // (lens cap, total darkness, uniform surface). Presentation-attack
  // detection lives in lib/liveness.js.
  if (stats.variance < 20) return { error: 'LOW_QUALITY' };

  return { decoded, stats };
}

function toTensor(decoded, tf) {
  const { width, height, data } = decoded;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return tf.tensor3d(rgb, [height, width, 3]);
}

const avgPoint = (points) => {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
};

// Vertical/horizontal ratio of an eye's landmark polygon. Drops sharply while
// the eye is closed, which is what makes a blink challenge verifiable.
function eyeAspectRatio(eye) {
  if (!eye || eye.length < 6) return null;
  const vertical = (Math.hypot(eye[1].x - eye[5].x, eye[1].y - eye[5].y)
    + Math.hypot(eye[2].x - eye[4].x, eye[2].y - eye[4].y)) / 2;
  const horizontal = Math.hypot(eye[0].x - eye[3].x, eye[0].y - eye[3].y);
  return horizontal > 0 ? vertical / horizontal : null;
}

// Signed, scale-free estimate of head yaw: where the nose tip sits between
// the two eye centres. ~0 looking straight ahead, negative turned one way,
// positive the other.
function yawRatio(leftEye, rightEye, nose) {
  const l = avgPoint(leftEye);
  const r = avgPoint(rightEye);
  const n = avgPoint(nose);
  const midX = (l.x + r.x) / 2;
  const eyeSpan = Math.abs(r.x - l.x);
  return eyeSpan > 0 ? (n.x - midX) / eyeSpan : 0;
}

/**
 * Full per-frame face analysis: the 128-float recognition descriptor PLUS the
 * geometric signals lib/liveness.js needs (eye openness, head yaw, face box,
 * image statistics). Everything here is derived server-side from the bytes
 * that were actually uploaded.
 */
export async function extractFaceDataDirect(jpegBuffer) {
  const modules = await initFaceEngine();
  if (!modules || !tfModule || !faceapiModule) {
    return { error: 'ENGINE_NOT_READY' };
  }
  const prepared = decodeJpeg(jpegBuffer);
  if (prepared.error) return { error: prepared.error };

  const tensor = toTensor(prepared.decoded, tfModule);
  try {
    const results = await faceapiModule
      .detectAllFaces(tensor, new faceapiModule.TinyFaceDetectorOptions({ inputSize: DETECTOR_INPUT_SIZE }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (results.length === 0) return { error: 'NO_FACE' };
    if (results.length > 1) return { error: 'MULTIPLE_FACES' };

    const [result] = results;
    const landmarks = result.landmarks;
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const nose = landmarks.getNose();
    const box = result.detection.box;

    return {
      descriptor: Array.from(result.descriptor),
      geometry: {
        leftEyeRatio: eyeAspectRatio(leftEye),
        rightEyeRatio: eyeAspectRatio(rightEye),
        yaw: yawRatio(leftEye, rightEye, nose),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        // Share of the frame the face occupies. A face held up on a phone
        // screen at arm's length is typically much smaller than a real one.
        faceAreaRatio: (box.width * box.height) / (prepared.decoded.width * prepared.decoded.height),
      },
      stats: prepared.stats,
    };
  } catch (err) {
    console.warn('[face] detection failed:', err.message);
    return { error: 'DETECTION_FAILED' };
  } finally {
    tfModule.dispose(tensor);
  }
}

// Internal CPU-bound descriptor extraction — kept as the narrow API most
// callers want.
export async function extractDescriptorDirect(jpegBuffer) {
  const result = await extractFaceDataDirect(jpegBuffer);
  if (result.error) return { error: result.error };
  return { descriptor: result.descriptor };
}

// Offloads the CPU-bound WASM work to a BOUNDED POOL of long-lived workers,
// so a burst of check-ins neither pins the request event loop nor spawns a
// thread per photo. See lib/faceWorkerPool.js for the measurement that drove
// this: 100 concurrent check-ins had a p50 of 19.2s before it existed.
export async function extractDescriptor(jpegBuffer) {
  if (process.env.DISABLE_FACE_WORKER === 'true' || process.env.NODE_ENV === 'test') {
    return extractDescriptorDirect(jpegBuffer);
  }
  try {
    const { runInPool } = await import('./faceWorkerPool.js');
    const result = await runInPool(jpegBuffer, 'descriptor');
    // A pool that is unavailable or saturated must not silently drop a punch —
    // fall back to in-process rather than failing the employee's check-in.
    if (result?.error === 'ENGINE_TIMEOUT' || result?.error === 'ENGINE_BUSY' || result?.error === 'WORKER_ERROR') {
      return extractDescriptorDirect(jpegBuffer);
    }
    return result;
  } catch {
    return extractDescriptorDirect(jpegBuffer);
  }
}

export async function extractFaceData(jpegBuffer) {
  if (process.env.DISABLE_FACE_WORKER === 'true' || process.env.NODE_ENV === 'test') {
    return extractFaceDataDirect(jpegBuffer);
  }
  try {
    const { runInPool } = await import('./faceWorkerPool.js');
    const result = await runInPool(jpegBuffer, 'faceData');
    if (result?.error === 'ENGINE_TIMEOUT' || result?.error === 'ENGINE_BUSY' || result?.error === 'WORKER_ERROR') {
      return extractFaceDataDirect(jpegBuffer);
    }
    return result;
  } catch {
    return extractFaceDataDirect(jpegBuffer);
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

export { euclideanDistance };

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
    case 'UNSUPPORTED_FORMAT': return 'The photo must be a JPEG image captured by the camera.';
    case 'IMAGE_TOO_LARGE': return 'That image is too large to process — capture a normal camera photo.';
    case 'DETECTION_FAILED': return 'Face detection failed on that photo — please try again.';
    case 'ENGINE_NOT_READY': return 'Face verification is temporarily unavailable — try again shortly.';
    default: return 'Face verification failed.';
  }
}
