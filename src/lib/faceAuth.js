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
