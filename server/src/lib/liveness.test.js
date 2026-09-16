// Liveness verification maths and challenge lifecycle.
//
// The face model itself is mocked so each test can present an exact,
// controlled sequence of frames — a replayed still, a head turn the wrong
// way, a burst with a stranger spliced in — and assert what the verifier
// concludes. That is the only way to prove a spoof is actually rejected;
// running the real model against real photos would test the model, not this
// logic.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const frameQueue = [];

vi.mock('./faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractFaceData: vi.fn(async () => {
      const next = frameQueue.shift();
      if (!next) return { error: 'NO_FACE' };
      return next;
    }),
  };
});

// Challenges now live in the SHARED (MongoDB-backed) store rather than a
// per-process Map, so that a challenge issued by one worker can be answered on
// another — see lib/sharedStore.js. That makes a real database part of the
// challenge lifecycle, which is why these tests boot one.
const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const SharedState = (await import('../models/SharedState.js')).default;

const {
  issueChallenge, consumeChallenge, verifyLiveness,
  CHALLENGE_ACTIONS, LIVENESS_TUNING, livenessFailureMessage,
} = await import('./liveness.js');

const ENROLLED = Array(128).fill(0);

// Builds a frame whose descriptor sits `drift` away from the enrolled one, so
// tests can dial frame-to-frame variation precisely.
function frame({ drift = 0, yaw = 0, eye = 0.30, area = 0.25 } = {}) {
  const descriptor = Array(128).fill(0);
  descriptor[0] = drift;
  return {
    descriptor,
    geometry: { leftEyeRatio: eye, rightEyeRatio: eye, yaw, faceAreaRatio: area },
    stats: { variance: 900 },
  };
}

function queue(frames) {
  frameQueue.length = 0;
  frameQueue.push(...frames);
}

// Distinct buffers so the sha256 duplicate check passes; the mock supplies
// the actual analysis.
const buffers = (n) => Array.from({ length: n }, (_, i) => Buffer.from(`frame-${i}-${Math.random()}`));

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });

beforeEach(async () => {
  frameQueue.length = 0;
  await clearTestDB();
});

describe('challenge issuance', () => {
  it('mints an unpredictable, single-use, expiring challenge', async () => {
    const a = await issueChallenge('user-1');
    const b = await issueChallenge('user-1');
    expect(a.challengeId).not.toBe(b.challengeId);
    expect(CHALLENGE_ACTIONS).toContain(a.action);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(a.minFrames).toBe(LIVENESS_TUNING.MIN_FRAMES);
  });

  it('consumes a challenge exactly once', async () => {
    const { challengeId } = await issueChallenge('user-1');
    expect(await consumeChallenge(challengeId, 'user-1')).toBeTruthy();
    // A captured burst cannot be replayed against the same challenge.
    expect(await consumeChallenge(challengeId, 'user-1')).toBeNull();
  });

  it('refuses a challenge issued to a DIFFERENT user', async () => {
    const { challengeId } = await issueChallenge('user-1');
    expect(await consumeChallenge(challengeId, 'user-2')).toBeNull();
  });

  it('refuses an unknown challenge id', async () => {
    expect(await consumeChallenge('deadbeef', 'user-1')).toBeNull();
  });

  it('lives in shared storage, so another worker can answer it', async () => {
    // The old in-process Map is why liveness broke under clustering: the
    // worker that received the answer had never heard of the challenge. The
    // record must be in the database, not in this process's memory.
    const { challengeId } = await issueChallenge('user-1');
    const stored = await SharedState.findOne({ key: `liveness:${challengeId}` }).lean();
    expect(stored, 'the challenge was not persisted for other workers').toBeTruthy();
    expect(stored.value.userId).toBe('user-1');
  });

  it('can only be consumed once even by two callers racing', async () => {
    const { challengeId } = await issueChallenge('user-1');
    // Concurrent consumption is one atomic findOneAndDelete each, so exactly
    // one of them can win — the property that makes it single-use across a
    // cluster rather than once per worker.
    const results = await Promise.all([
      consumeChallenge(challengeId, 'user-1'),
      consumeChallenge(challengeId, 'user-1'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('replay and spoof rejection', () => {
  it('rejects a burst that is really one still image repeated', async () => {
    // The classic attack: hold up a printed photo / phone screen. Every frame
    // produces essentially the same descriptor.
    queue([frame(), frame(), frame(), frame()]);
    const result = await verifyLiveness({
      frameBuffers: buffers(4), action: 'turn-left', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('STATIC_IMAGE_REPLAY');
  });

  it('rejects byte-identical duplicate frames before touching the model', async () => {
    const dup = Buffer.from('same-bytes');
    const result = await verifyLiveness({
      frameBuffers: [dup, dup, dup], action: 'blink', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('DUPLICATE_FRAMES');
  });

  it('rejects a burst with too few frames', async () => {
    const result = await verifyLiveness({
      frameBuffers: buffers(1), action: 'blink', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TOO_FEW_FRAMES');
  });

  it('rejects a burst where a DIFFERENT person appears in any frame', async () => {
    // Buddy punching: the enrolled employee starts the capture, a colleague
    // completes the motion. Every frame is matched, not just the first.
    queue([
      frame({ drift: 0.00, yaw: -0.05 }),
      frame({ drift: 0.05, yaw: 0.05 }),
      frame({ drift: 5.00, yaw: 0.25 }), // far outside the match threshold
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-right', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('FACE_NOT_MATCHED');
  });

  it('rejects frames spliced from unrelated captures', async () => {
    queue([
      frame({ drift: 0.00, yaw: -0.10 }),
      frame({ drift: 0.46, yaw: 0.20 }), // large jump, still inside match threshold
      frame({ drift: 0.00, yaw: 0.25 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-right', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INCONSISTENT_FRAMES');
  });

  it('rejects a face occupying too little of the frame (photo held at a distance)', async () => {
    queue([
      frame({ drift: 0.00, yaw: -0.10, area: 0.005 }),
      frame({ drift: 0.05, yaw: 0.05, area: 0.005 }),
      frame({ drift: 0.10, yaw: 0.20, area: 0.005 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-right', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('FACE_TOO_SMALL');
  });

  it('propagates a per-frame detection failure', async () => {
    queue([frame(), { error: 'NO_FACE' }, frame()]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'blink', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_FACE');
  });
});

describe('commanded motion must actually occur', () => {
  it('accepts a genuine turn to the right', async () => {
    queue([
      frame({ drift: 0.00, yaw: -0.10 }),
      frame({ drift: 0.05, yaw: 0.05 }),
      frame({ drift: 0.10, yaw: 0.22 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-right', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(true);
    expect(result.detail.strength).toBe('active-challenge');
    expect(result.detail.action).toBe('turn-right');
    expect(result.detail.frameCount).toBe(3);
  });

  it('rejects turning the WRONG way', async () => {
    // A pre-recorded clip satisfies "some head movement" but cannot satisfy a
    // direction the server picked after the recording was made.
    queue([
      frame({ drift: 0.00, yaw: 0.22 }),
      frame({ drift: 0.05, yaw: 0.05 }),
      frame({ drift: 0.10, yaw: -0.10 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-right', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('WRONG_DIRECTION');
  });

  it('rejects a burst with movement below the threshold', async () => {
    queue([
      frame({ drift: 0.00, yaw: 0.00 }),
      frame({ drift: 0.05, yaw: 0.01 }),
      frame({ drift: 0.10, yaw: 0.02 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-left', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_HEAD_MOVEMENT');
  });

  it('accepts a genuine blink', async () => {
    queue([
      frame({ drift: 0.00, eye: 0.31 }),
      frame({ drift: 0.05, eye: 0.08 }), // eyes closed
      frame({ drift: 0.10, eye: 0.30 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'blink', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(true);
    expect(result.detail.motion.minEyeOpen).toBeLessThan(result.detail.motion.maxEyeOpen);
  });

  it('rejects eyes-open-throughout when a blink was commanded', async () => {
    queue([
      frame({ drift: 0.00, eye: 0.30 }),
      frame({ drift: 0.05, eye: 0.29 }),
      frame({ drift: 0.10, eye: 0.31 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'blink', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_BLINK_DETECTED');
  });
});

describe('what a successful result claims', () => {
  it('states its own limits instead of asserting certified anti-spoofing', async () => {
    queue([
      frame({ drift: 0.00, yaw: 0.20 }),
      frame({ drift: 0.05, yaw: 0.05 }),
      frame({ drift: 0.10, yaw: -0.10 }),
    ]);
    const result = await verifyLiveness({
      frameBuffers: buffers(3), action: 'turn-left', enrolledDescriptor: ENROLLED,
    });
    expect(result.ok).toBe(true);
    // The stored audit detail must be honest about what was and was not tested.
    expect(result.detail.limits).toMatch(/Not verified against video replay/);
    expect(result.detail).not.toHaveProperty('certified');
    expect(result.detail.checkedAt).toBeTruthy();
  });

  it('has a human-readable message for every failure reason it can return', () => {
    const reasons = [
      'TOO_FEW_FRAMES', 'TOO_MANY_FRAMES', 'DUPLICATE_FRAMES', 'STATIC_IMAGE_REPLAY',
      'INCONSISTENT_FRAMES', 'FACE_TOO_SMALL', 'NO_HEAD_MOVEMENT', 'WRONG_DIRECTION',
      'NO_BLINK_DETECTED', 'EYES_NOT_MEASURABLE', 'CHALLENGE_EXPIRED', 'FACE_NOT_MATCHED',
    ];
    for (const reason of reasons) {
      expect(livenessFailureMessage(reason)).not.toBe('Liveness check failed — please try again.');
    }
  });
});
