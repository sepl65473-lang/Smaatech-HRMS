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

  it('registers a real blink even when polling only catches it mid-motion, not fully closed', () => {
    // A spontaneous blink lasts ~100-300ms, often shorter than one polling
    // tick — so in practice the sample that lands during the blink is
    // usually a partial closure (eyelid partway down), and the very next
    // sample after reopening is rarely an exact match of the prior peak
    // (ordinary landmark jitter). This is the realistic case the old
    // stricter ratios (0.75 close / 0.85 reopen) were missing.
    const tracker = createBlinkTracker();
    const frames = [
      0.30, 0.29, 0.31, // stable open baseline
      0.22, // only a partial dip was sampled (~73% of peak), not a fully-shut frame
      0.25, // reopening, but landmark noise keeps it a bit below the original peak
    ];
    const results = frames.map((ear) => tracker.update(ear));
    expect(results.some(Boolean)).toBe(true);
  });
});
