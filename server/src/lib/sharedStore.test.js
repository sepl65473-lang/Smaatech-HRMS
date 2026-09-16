// The shared, cluster-safe state store.
//
// These tests are about ONE property: two workers racing on the same key must
// produce exactly one winner. That is what the in-process Maps this replaced
// could not provide, and it is what stops a replayed QR scan, a replayed
// liveness burst, and a double F&F payout.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const SharedState = (await import('../models/SharedState.js')).default;
const {
  putShared, getShared, takeShared, claimShared, updateShared, removeShared, sharedCount,
} = await import('./sharedStore.js');

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('put / get', () => {
  it('round-trips a value', async () => {
    await putShared('k1', { hello: 'world' }, 60_000);
    expect(await getShared('k1')).toEqual({ hello: 'world' });
  });

  it('treats an expired entry as absent, without waiting for the TTL monitor', async () => {
    // Mongo's TTL sweep runs about once a minute, so an expired document is
    // routinely still present. Reads must not trust it.
    await putShared('k2', 'stale', -1000);
    expect(await getShared('k2')).toBeNull();
    expect(await SharedState.countDocuments({ key: 'k2' })).toBe(1); // still on disk
  });

  it('overwrites an existing key', async () => {
    await putShared('k3', 'first', 60_000);
    await putShared('k3', 'second', 60_000);
    expect(await getShared('k3')).toBe('second');
  });
});

describe('takeShared — single use', () => {
  it('returns the value and removes it', async () => {
    await putShared('once', 'payload', 60_000);
    expect(await takeShared('once')).toBe('payload');
    expect(await takeShared('once')).toBeNull();
  });

  it('gives the value to exactly ONE of two concurrent callers', async () => {
    await putShared('race', 'payload', 60_000);
    const results = await Promise.all([
      takeShared('race'), takeShared('race'), takeShared('race'),
    ]);
    expect(results.filter((r) => r !== null)).toEqual(['payload']);
  });

  it('refuses an expired entry', async () => {
    await putShared('gone', 'payload', -1);
    expect(await takeShared('gone')).toBeNull();
  });
});

describe('claimShared — exactly one winner', () => {
  it('lets the first caller claim and reports the holder to the rest', async () => {
    const first = await claimShared('claim1', { state: 'in-flight' }, 60_000);
    expect(first.claimed).toBe(true);

    const second = await claimShared('claim1', { state: 'in-flight' }, 60_000);
    expect(second.claimed).toBe(false);
    expect(second.value).toEqual({ state: 'in-flight' });
  });

  it('produces exactly one winner under concurrency', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => claimShared('claim2', { state: 'in-flight' }, 60_000)),
    );
    expect(attempts.filter((a) => a.claimed)).toHaveLength(1);
  });

  it('lets an EXPIRED claim be reclaimed, so a crashed worker cannot block a key', async () => {
    await claimShared('claim3', { state: 'in-flight' }, -1);
    const retry = await claimShared('claim3', { state: 'in-flight' }, 60_000);
    expect(retry.claimed).toBe(true);
  });
});

describe('update / remove / count', () => {
  it('updates a claimed key in place', async () => {
    await claimShared('u1', { state: 'in-flight' }, 60_000);
    await updateShared('u1', { state: 'done', statusCode: 200 }, 60_000);
    expect(await getShared('u1')).toEqual({ state: 'done', statusCode: 200 });
  });

  it('removes a key', async () => {
    await putShared('r1', 'x', 60_000);
    await removeShared('r1');
    expect(await getShared('r1')).toBeNull();
  });

  it('counts only live entries, by prefix', async () => {
    await putShared('pfx:a', 1, 60_000);
    await putShared('pfx:b', 2, 60_000);
    await putShared('pfx:c', 3, -1);
    await putShared('other:d', 4, 60_000);

    expect(await sharedCount('pfx:')).toBe(2);
    expect(await sharedCount()).toBe(3);
  });
});
