import SharedState from '../models/SharedState.js';

/**
 * Cluster-safe short-lived state, backed by MongoDB (see models/SharedState.js
 * for why this replaced in-process Maps).
 *
 * Every operation that must not happen twice — consuming a single-use token,
 * claiming an idempotency key — is expressed as ONE atomic Mongo command, so
 * two workers racing on the same key produce exactly one winner.
 */

// No floor on the TTL: a caller passing a non-positive value means "already
// expired", and silently clamping it to +1ms would make an entry briefly live
// that was never meant to be.
const expiryFor = (ttlMs) => new Date(Date.now() + Number(ttlMs || 0));

/** Writes (or overwrites) a key. */
export async function putShared(key, value, ttlMs) {
  await SharedState.findOneAndUpdate(
    { key },
    { key, value, expiresAt: expiryFor(ttlMs) },
    { upsert: true, new: true },
  );
  return value;
}

/** Reads a key, treating an expired-but-not-yet-reaped entry as absent. */
export async function getShared(key) {
  const doc = await SharedState.findOne({ key }).lean();
  if (!doc) return null;
  if (doc.expiresAt.getTime() < Date.now()) return null;
  return doc.value;
}

/**
 * Reads AND deletes in one atomic step — the single-use primitive.
 *
 * Two workers calling this concurrently for the same key: exactly one gets the
 * value, the other gets null. That is what makes a QR token or a liveness
 * challenge genuinely single-use across a cluster rather than once per worker.
 */
export async function takeShared(key) {
  const doc = await SharedState.findOneAndDelete({ key }).lean();
  if (!doc) return null;
  if (doc.expiresAt.getTime() < Date.now()) return null;
  return doc.value;
}

/**
 * Claims a key only if nobody else holds it.
 *
 * Returns { claimed: true } for the winner and { claimed: false, value } for
 * everyone else, relying on the unique index on `key` rather than a
 * check-then-write, which has a race between the two steps.
 */
export async function claimShared(key, value, ttlMs) {
  const now = new Date();
  try {
    // Reclaim an expired entry in the same command, so a key is never blocked
    // by an entry the TTL monitor has not got round to yet.
    const doc = await SharedState.findOneAndUpdate(
      { key, expiresAt: { $lt: now } },
      { key, value, expiresAt: expiryFor(ttlMs) },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return { claimed: true, value: doc.value };
  } catch (err) {
    if (err.code === 11000) {
      // Someone live holds it.
      const existing = await SharedState.findOne({ key }).lean();
      if (!existing) return claimShared(key, value, ttlMs);
      return { claimed: false, value: existing.value };
    }
    throw err;
  }
}

/** Replaces the value of a key already claimed, keeping its expiry window. */
export async function updateShared(key, value, ttlMs) {
  await SharedState.updateOne(
    { key },
    { value, ...(ttlMs ? { expiresAt: expiryFor(ttlMs) } : {}) },
  );
  return value;
}

export async function removeShared(key) {
  await SharedState.deleteOne({ key });
}

/** Live (unexpired) entry count — used by health/diagnostics. */
export async function sharedCount(prefix = '') {
  return SharedState.countDocuments({
    expiresAt: { $gte: new Date() },
    ...(prefix ? { key: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) } : {}),
  });
}
