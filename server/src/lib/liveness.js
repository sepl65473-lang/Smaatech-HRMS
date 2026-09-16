import crypto from 'node:crypto';
import { putShared, takeShared, sharedCount } from './sharedStore.js';
import { extractFaceData, matchDescriptor, euclideanDistance } from './faceEngine.js';

/**
 * ACTIVE CHALLENGE–RESPONSE LIVENESS.
 *
 * What was here before: a single still photo, plus a luminance-variance check
 * in the decoder labelled "PAD heuristic". That rejects a blank frame and
 * nothing else — a printed photo, a phone screen, or a colleague's saved
 * selfie all pass it comfortably. It was NOT liveness, so nothing in this
 * codebase should have called it that.
 *
 * What this does instead, entirely server-side:
 *
 *   1. The server mints a random, single-use, short-TTL challenge naming a
 *      motion the user must perform (turn left / turn right / blink). The
 *      client cannot predict it, so a pre-recorded clip can't satisfy it.
 *   2. The client uploads a short burst of frames.
 *   3. The server re-detects every frame itself and checks, in order:
 *        a. every frame is the SAME enrolled person (descriptor match), so
 *           the motion can't be performed by a second person;
 *        b. the frames are genuinely DIFFERENT images — a replayed still,
 *           duplicated and re-encoded, is rejected;
 *        c. the frames are not TOO different — a cut between unrelated
 *           images (e.g. two saved photos) is rejected;
 *        d. the commanded motion actually occurred, measured from 68-point
 *           landmark geometry (head yaw for turns, eye-aspect-ratio dip for
 *           a blink).
 *
 * Honest limits, stated so nobody over-claims from this again:
 *   - This defeats a printed photo and a static screen image. It does NOT
 *     defeat a sophisticated video replay on a high-quality display, a
 *     deepfake, or a 3D mask. Defeating those needs a trained
 *     presentation-attack-detection model plus depth/IR hardware, neither of
 *     which exists in this deployment.
 *   - So the result carries `strength: 'active-challenge'` rather than any
 *     claim of certified PAD, and the audit record stores exactly which
 *     checks passed.
 */

const CHALLENGE_TTL_MS = 90 * 1000;
const MIN_FRAMES = 3;
const MAX_FRAMES = 8;

// Head must move at least this much (in eye-span units) for a turn to count.
const YAW_DELTA_THRESHOLD = 0.12;
// Eye-aspect ratio must fall to this fraction of its open value for a blink.
const BLINK_CLOSE_RATIO = 0.62;
// Consecutive frames must differ by at least this descriptor distance — a
// replayed identical still produces a distance of ~0.
const MIN_FRAME_VARIATION = 0.02;
// ...but not by more than this, which would mean a different capture entirely.
const MAX_FRAME_VARIATION = 0.45;
// A face occupying a tiny share of the frame is typically a photo-of-a-photo
// held at a distance rather than someone standing at the camera.
const MIN_FACE_AREA_RATIO = 0.02;

export const CHALLENGE_ACTIONS = ['turn-left', 'turn-right', 'blink'];

// Challenges live in the SHARED store, not in this process.
//
// They were an in-process Map. Under clustering (ENABLE_CLUSTER /
// WEB_CONCURRENCY, or more than one Render instance) the request that issues a
// challenge and the request that answers it routinely land on different
// workers — so the answer was checked against a worker that had never heard of
// the challenge, and liveness failed for a reason that had nothing to do with
// the person in front of the camera. Holding them in Mongo also makes
// "consumed exactly once" true across the whole deployment rather than
// per-worker.
const CHALLENGE_KEY_PREFIX = 'liveness:';

export async function issueChallenge(userId) {
  const challengeId = crypto.randomBytes(18).toString('hex');
  // crypto.randomInt, not Math.random: the whole point is that the client
  // cannot predict or pre-record the response.
  const action = CHALLENGE_ACTIONS[crypto.randomInt(CHALLENGE_ACTIONS.length)];
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  await putShared(
    `${CHALLENGE_KEY_PREFIX}${challengeId}`,
    { userId: String(userId), action, expiresAt },
    CHALLENGE_TTL_MS,
  );
  return { challengeId, action, expiresAt, minFrames: MIN_FRAMES, maxFrames: MAX_FRAMES };
}

// Single-use: consumed on first lookup — one atomic delete — so a captured
// burst cannot be replayed against the same challenge, on this worker or any
// other.
export async function consumeChallenge(challengeId, userId) {
  if (!challengeId) return null;
  const entry = await takeShared(`${CHALLENGE_KEY_PREFIX}${challengeId}`);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  if (entry.userId !== String(userId)) return null;
  return entry;
}

export function pendingChallengeCount() {
  return sharedCount(CHALLENGE_KEY_PREFIX);
}


function openEyeRatio(geometry) {
  const ratios = [geometry.leftEyeRatio, geometry.rightEyeRatio].filter((r) => typeof r === 'number');
  if (!ratios.length) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function evaluateMotion(action, frames) {
  const yaws = frames.map((f) => f.geometry.yaw);
  const eyes = frames.map((f) => openEyeRatio(f.geometry)).filter((r) => r != null);

  if (action === 'blink') {
    if (eyes.length < MIN_FRAMES) {
      return { ok: false, reason: 'EYES_NOT_MEASURABLE' };
    }
    const maxOpen = Math.max(...eyes);
    const minOpen = Math.min(...eyes);
    const ok = maxOpen > 0 && minOpen <= maxOpen * BLINK_CLOSE_RATIO;
    return {
      ok,
      reason: ok ? null : 'NO_BLINK_DETECTED',
      measured: { maxEyeOpen: Number(maxOpen.toFixed(4)), minEyeOpen: Number(minOpen.toFixed(4)) },
    };
  }

  const minYaw = Math.min(...yaws);
  const maxYaw = Math.max(...yaws);
  const delta = maxYaw - minYaw;
  if (delta < YAW_DELTA_THRESHOLD) {
    return { ok: false, reason: 'NO_HEAD_MOVEMENT', measured: { yawDelta: Number(delta.toFixed(4)) } };
  }

  // Direction: the sequence must END further toward the commanded side than
  // it started, so turning the opposite way doesn't satisfy the challenge.
  const movedRight = yaws[yaws.length - 1] > yaws[0];
  const expectedRight = action === 'turn-right';
  const ok = movedRight === expectedRight;
  return {
    ok,
    reason: ok ? null : 'WRONG_DIRECTION',
    measured: { yawStart: Number(yaws[0].toFixed(4)), yawEnd: Number(yaws[yaws.length - 1].toFixed(4)), yawDelta: Number(delta.toFixed(4)) },
  };
}

/**
 * Verifies a burst of frames against an issued challenge and an enrolled face.
 *
 * Returns { ok, reason, detail } — `detail` is what gets stored on the
 * attendance row so an auditor can see exactly which checks passed, rather
 * than a bare "liveness: true".
 */
export async function verifyLiveness({ frameBuffers, action, enrolledDescriptor }) {
  if (!Array.isArray(frameBuffers) || frameBuffers.length < MIN_FRAMES) {
    return { ok: false, reason: 'TOO_FEW_FRAMES' };
  }
  if (frameBuffers.length > MAX_FRAMES) {
    return { ok: false, reason: 'TOO_MANY_FRAMES' };
  }

  // Byte-identical duplicates are the cheapest replay: catch them before
  // spending any model time.
  const hashes = frameBuffers.map((b) => crypto.createHash('sha256').update(b).digest('hex'));
  if (new Set(hashes).size !== hashes.length) {
    return { ok: false, reason: 'DUPLICATE_FRAMES' };
  }

  const frames = [];
  for (const buffer of frameBuffers) {
    // eslint-disable-next-line no-await-in-loop
    const data = await extractFaceData(buffer);
    if (data.error) return { ok: false, reason: data.error };
    frames.push(data);
  }

  // (a) Every frame must be the same enrolled person.
  let worstConfidence = 100;
  for (const frame of frames) {
    const match = matchDescriptor(frame.descriptor, enrolledDescriptor);
    if (!match.matched) return { ok: false, reason: 'FACE_NOT_MATCHED' };
    worstConfidence = Math.min(worstConfidence, match.confidence);
  }

  // Face too small in frame -> likely a photo held up to the camera.
  const minArea = Math.min(...frames.map((f) => f.geometry.faceAreaRatio));
  if (minArea < MIN_FACE_AREA_RATIO) {
    return { ok: false, reason: 'FACE_TOO_SMALL', detail: { minFaceAreaRatio: Number(minArea.toFixed(4)) } };
  }

  // (b)+(c) Consecutive frames must differ, but be the same capture session.
  const variations = [];
  for (let i = 1; i < frames.length; i += 1) {
    variations.push(euclideanDistance(frames[i].descriptor, frames[i - 1].descriptor));
  }
  const maxVariation = Math.max(...variations);
  if (maxVariation < MIN_FRAME_VARIATION) {
    // Every frame is effectively the same image — a still, re-encoded.
    return { ok: false, reason: 'STATIC_IMAGE_REPLAY', detail: { maxFrameVariation: Number(maxVariation.toFixed(4)) } };
  }
  if (maxVariation > MAX_FRAME_VARIATION) {
    return { ok: false, reason: 'INCONSISTENT_FRAMES', detail: { maxFrameVariation: Number(maxVariation.toFixed(4)) } };
  }

  // (d) The commanded motion must actually have happened.
  const motion = evaluateMotion(action, frames);
  if (!motion.ok) {
    return { ok: false, reason: motion.reason, detail: motion.measured };
  }

  return {
    ok: true,
    reason: null,
    detail: {
      // Deliberately NOT the word "certified" or a percentage — this is what
      // was actually checked, and nothing more.
      strength: 'active-challenge',
      action,
      frameCount: frames.length,
      minMatchConfidence: Math.round(worstConfidence),
      maxFrameVariation: Number(maxVariation.toFixed(4)),
      minFaceAreaRatio: Number(minArea.toFixed(4)),
      motion: motion.measured || null,
      checkedAt: new Date().toISOString(),
      limits: 'Defeats printed-photo and static-screen presentation. Not verified against video replay, deepfake or 3D mask.',
    },
  };
}

export function livenessFailureMessage(reason) {
  switch (reason) {
    case 'TOO_FEW_FRAMES': return 'Not enough frames captured — hold still and let the camera record the full prompt.';
    case 'TOO_MANY_FRAMES': return 'Too many frames submitted.';
    case 'DUPLICATE_FRAMES': return 'The same image was submitted more than once — capture a live sequence.';
    case 'STATIC_IMAGE_REPLAY': return 'That looks like a still image rather than a live camera feed.';
    case 'INCONSISTENT_FRAMES': return 'The captured frames do not look like one continuous capture.';
    case 'FACE_TOO_SMALL': return 'Move closer to the camera so your face fills more of the frame.';
    case 'NO_HEAD_MOVEMENT': return 'No head movement detected — please follow the on-screen prompt.';
    case 'WRONG_DIRECTION': return 'That was the wrong direction — please follow the on-screen prompt.';
    case 'NO_BLINK_DETECTED': return 'No blink detected — please blink when prompted.';
    case 'EYES_NOT_MEASURABLE': return 'Could not see your eyes clearly — remove glare or reflective glasses and try again.';
    case 'CHALLENGE_EXPIRED': return 'That liveness prompt expired — request a new one and try again.';
    case 'FACE_NOT_MATCHED': return "That doesn't match your enrolled face.";
    default: return 'Liveness check failed — please try again.';
  }
}

export const LIVENESS_TUNING = {
  CHALLENGE_TTL_MS, MIN_FRAMES, MAX_FRAMES,
  YAW_DELTA_THRESHOLD, BLINK_CLOSE_RATIO,
  MIN_FRAME_VARIATION, MAX_FRAME_VARIATION, MIN_FACE_AREA_RATIO,
};
