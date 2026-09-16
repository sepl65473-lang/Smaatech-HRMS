import mongoose from 'mongoose';

/**
 * A small, TTL-expiring key/value store shared by every worker.
 *
 * WHY: several pieces of state were held in a per-process `Map`. That is
 * correct for exactly one Node process and silently wrong the moment the app
 * runs more than one (ENABLE_CLUSTER / WEB_CONCURRENCY, or two Render
 * instances):
 *
 *   - a single-use QR token issued by worker A was unknown to worker B, so the
 *     same scan could be replayed once per worker;
 *   - a liveness challenge issued by worker A could not be consumed by worker
 *     B, so liveness failed for reasons unrelated to the person in front of
 *     the camera;
 *   - an Idempotency-Key seen by worker A did not stop worker B from executing
 *     the same request again — on the F&F payout route, that is a second
 *     disbursement.
 *
 * MongoDB is already in the stack, so this needs no new infrastructure. The
 * TTL index is the janitor; nothing here needs a sweep timer.
 */
const sharedStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  // Mongo's TTL monitor removes a document once this instant has passed. It
  // runs about once a minute, so an entry can outlive its expiry by up to that
  // long — every read below therefore checks expiresAt itself rather than
  // trusting the index for correctness.
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

sharedStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.SharedState || mongoose.model('SharedState', sharedStateSchema);
