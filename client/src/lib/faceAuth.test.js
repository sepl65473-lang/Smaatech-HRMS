import { describe, it, expect } from 'vitest';
import { createBlinkTracker } from './faceAuth';

describe('createBlinkTracker', () => {
  it('registers a normal blink cycle (open -> closed -> reopened)', () => {
    const tracker = createBlinkTracker();
    const results = [0.30, 0.29, 0.31, 0.10, 0.29].map((ear) => tracker.update(ear));
    expect(results.some(Boolean)).toBe(true);
  });

  it('does not get permanently stuck after a single noisy/outlier landmark reading inflates the baseline', () => {
    // Simulates a real-world glitch: the very first frame or two, while the
    // camera/face is still settling, produces an implausible EAR spike from
    // bad landmark detection — not a real "wide open eye" reading.
    const tracker = createBlinkTracker();
    const frames = [
      0.30, // first genuine open-eye reading
      0.55, // noisy outlier spike (landmark glitch, not a real eye state)
      0.29, 0.30, 0.28, // camera settles back to a normal open baseline
      0.10, // a real blink close
      0.29, // a real blink reopen
    ];
    const results = frames.map((ear) => tracker.update(ear));
    expect(results.some(Boolean)).toBe(true);
  });

  it('ignores implausible EAR values entirely rather than using them as a baseline', () => {
    const tracker = createBlinkTracker();
    expect(tracker.update(0.9)).toBe(false); // impossible EAR, should be discarded, not adopted as maxEar
    const results = [0.30, 0.29, 0.10, 0.29].map((ear) => tracker.update(ear));
    expect(results.some(Boolean)).toBe(true);
  });
});
