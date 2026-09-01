const MODEL_URL = '/models';
const MATCH_THRESHOLD = 0.5; // euclidean distance; lower = more confident match

// face-api.js (+ TensorFlow.js) is several hundred KB — only fetch it when
// face enrollment/login is actually used, not on every app load.
let faceapiPromise = null;
async function getFaceApi() {
  if (!faceapiPromise) {
    const faceapi = await import('face-api.js');
    faceapiPromise = faceapi.default && faceapi.default.nets ? faceapi.default : faceapi;
  }
  return faceapiPromise;
}

let modelsLoaded = null;
export async function loadFaceModels() {
  const faceapi = await getFaceApi();
  if (!modelsLoaded) {
    modelsLoaded = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
  }
  await modelsLoaded;
  return faceapi;
}

// Runs detection + landmarks + a 128-value face descriptor on a video/image element.
export async function detectFaceDescriptor(mediaEl) {
  const faceapi = await getFaceApi();
  const result = await faceapi
    .detectSingleFace(mediaEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return result ? Array.from(result.descriptor) : null;
}

// Landmarks-only detection (cheaper than the full descriptor pass above) —
// used to sample eye-aspect-ratio every tick while watching for a blink,
// before the heavier descriptor extraction runs on the final captured frame.
export async function detectFaceLandmarks(mediaEl) {
  const faceapi = await getFaceApi();
  const result = await faceapi
    .detectSingleFace(mediaEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks();
  return result ? result.landmarks : null;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function earFor(eyePoints) {
  const vertical1 = dist(eyePoints[1], eyePoints[5]);
  const vertical2 = dist(eyePoints[2], eyePoints[4]);
  const horizontal = dist(eyePoints[0], eyePoints[3]);
  return horizontal ? (vertical1 + vertical2) / (2 * horizontal) : 0;
}

// Eye-aspect-ratio (Soukupová & Čech) — drops sharply during a blink, using
// only the 68-point landmark model this app already loads for check-in; no
// new model download needed. This is NOT a dedicated anti-spoofing model
// (face-api.js ships none) — it's a lighter, real signal that a static
// printed photo or a screen replay can't easily reproduce on demand, not a
// bulletproof liveness guarantee.
export function eyeAspectRatio(landmarks) {
  const left = landmarks.getLeftEye();
  const right = landmarks.getRightEye();
  return (earFor(left) + earFor(right)) / 2;
}

// Fraction of the user's own observed "eyes open" baseline that counts as
// closed/reopened. Relative, not a fixed absolute EAR value — a universal
// number doesn't generalize across different face shapes, camera angles, or
// lighting (someone whose natural open-eye EAR sits lower than a fixed
// threshold would never be able to "reopen" past it, getting stuck forever).
const CLOSE_RATIO = 0.75;
const REOPEN_RATIO = 0.85;

// Tracks a full closed -> reopened cycle across successive EAR samples (a
// real blink), not just "EAR dipped somewhere" — a momentarily bad landmark
// read on an open eye shouldn't count. Self-calibrates to this session's own
// observed peak EAR (the most "open" the eyes have been seen so far) instead
// of a fixed universal number.
export function createBlinkTracker() {
  let maxEar = 0;
  let sawClosed = false;
  return {
    update(ear) {
      if (!sawClosed && ear > maxEar) maxEar = ear;
      if (maxEar === 0) return false; // no open-eye baseline observed yet
      if (ear < maxEar * CLOSE_RATIO) {
        sawClosed = true;
        return false;
      }
      if (sawClosed && ear > maxEar * REOPEN_RATIO) {
        sawClosed = false;
        return true;
      }
      return false;
    },
  };
}

// Finds the closest enrolled profile to a live descriptor, if within threshold.
export async function matchFace(liveDescriptor, profiles) {
  const faceapi = await getFaceApi();
  let best = null;
  let bestDistance = Infinity;
  profiles.forEach((p) => {
    if (!p.faceDescriptor?.length) return;
    const distance = faceapi.euclideanDistance(liveDescriptor, p.faceDescriptor);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  });
  return bestDistance <= MATCH_THRESHOLD ? best : null;
}
