import { claimShared, getShared, updateShared, removeShared } from '../lib/sharedStore.js';

/**
 * Idempotency-Key support, shared across every worker.
 *
 * This used to be an in-process Map. On a single process that works; with
 * clustering (ENABLE_CLUSTER / WEB_CONCURRENCY) or a second instance it does
 * not — worker A remembering a key does nothing to stop worker B executing the
 * same request again. The route this guards is the Full & Final PAYOUT, so the
 * failure mode is a second disbursement of real money.
 *
 * The store now holds three things per key:
 *   - a CLAIM, written atomically, so exactly one request proceeds;
 *   - the RESPONSE once that request succeeds, replayed to later retries;
 *   - nothing, if it failed — so a retry after an error is allowed to run.
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// A claim that is never completed (a crashed or killed worker) must not block
// the key for a full day.
const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;

export function idempotency(options = {}) {
  const { required = false } = options;

  return async (req, res, next) => {
    const key = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (!key) {
      if (required) {
        return res.status(400).json({
          error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'An Idempotency-Key header is required for this transaction.' },
        });
      }
      return next();
    }

    const company = req.auth?.company || 'Smaatech';
    const storeKey = `idem:${company}:${String(key).slice(0, 200)}`;

    const claim = await claimShared(storeKey, { state: 'in-flight' }, IN_FLIGHT_TTL_MS);

    if (!claim.claimed) {
      const held = claim.value || (await getShared(storeKey));
      if (held?.state === 'done') {
        res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_HIT');
        return res.status(held.statusCode).json(held.body);
      }
      // The original request is still running, here or on another worker.
      // Returning 409 rather than executing it a second time is the whole
      // point: two concurrent retries of one payout must not both pay.
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENT_IN_FLIGHT',
          message: 'An identical request is already being processed. Retry shortly.',
        },
      });
    }

    // Capture the response so a later retry of the same key replays it.
    const originalJson = res.json.bind(res);
    let settled = false;
    res.json = (body) => {
      if (!settled) {
        settled = true;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          updateShared(storeKey, { state: 'done', statusCode: res.statusCode, body }, IDEMPOTENCY_TTL_MS)
            .catch(() => { /* the response still goes out; a retry simply re-runs */ });
        } else {
          // A failed attempt must not be remembered as the answer — otherwise
          // a transient 500 would be replayed for 24 hours and the operation
          // could never be retried.
          removeShared(storeKey).catch(() => {});
        }
      }
      return originalJson(body);
    };

    // A request that dies without ever calling res.json (a thrown error handled
    // elsewhere, a dropped connection) must release its claim too.
    res.on('close', () => {
      if (!settled) removeShared(storeKey).catch(() => {});
    });

    return next();
  };
}
