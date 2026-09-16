import { describe, it, expect, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * The pool is disabled under NODE_ENV=test so the rest of the suite does not
 * pay thread-startup cost. That would leave the real worker path - which sits
 * directly in the authentication flow - completely untested, so this file
 * switches it on deliberately.
 */
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
// Explicit opt-in: the pool stays off for every other suite.
process.env.HASH_WORKER_FORCE = 'true';
process.env.HASH_WORKER_POOL_SIZE = '2';

const { comparePassword, hashPassword, poolStats, stopHashPool } = await import('./passwordHasher.js');

afterAll(async () => {
  await stopHashPool();
  delete process.env.HASH_WORKER_FORCE;
  process.env.NODE_ENV = originalNodeEnv;
});

describe('password hashing through the worker pool', () => {
  it('produces a hash the standard library accepts', async () => {
    // Format compatibility is the whole point: existing stored hashes must
    // keep verifying, so this must be ordinary bcrypt output.
    const hash = await hashPassword('CorrectHorse123', 10);
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare('CorrectHorse123', hash)).toBe(true);
  });

  it('verifies a hash produced by the standard library', async () => {
    const hash = await bcrypt.hash('LegacyPassword123', 10);
    expect(await comparePassword('LegacyPassword123', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('RightOne123', 10);
    expect(await comparePassword('WrongOne123', hash)).toBe(false);
  });

  it('rejects rather than throws when there is no stored hash', async () => {
    expect(await comparePassword('anything', null)).toBe(false);
    expect(await comparePassword('anything', '')).toBe(false);
  });

  it('handles many concurrent comparisons without losing or crossing results', async () => {
    // A pool that mismatched a reply to the wrong waiter would authenticate
    // the wrong person, so each task carries a distinct password and the
    // expected answer differs per task.
    const hashes = await Promise.all(
      Array.from({ length: 24 }, (_, i) => hashPassword(`pw-${i}-Aa1`, 10)),
    );
    const correct = await Promise.all(hashes.map((h, i) => comparePassword(`pw-${i}-Aa1`, h)));
    expect(correct.every(Boolean)).toBe(true);

    // Same hashes, deliberately shifted passwords: every one must fail.
    const shifted = await Promise.all(hashes.map((h, i) => comparePassword(`pw-${(i + 1) % 24}-Aa1`, h)));
    expect(shifted.some(Boolean)).toBe(false);
  });

  it('keeps the pool bounded', () => {
    const stats = poolStats();
    expect(stats.configured).toBe(2);
    expect(stats.size).toBeLessThanOrEqual(2);
  });
});
