// Memory store for Idempotency Keys with 24-hour TTL automatic cleanup
const idempotencyStore = new Map();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (record.expiresAt < now) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 60 * 1000);

export function idempotency(options = {}) {
  const { required = false } = options;

  return (req, res, next) => {
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
    const storeKey = `${company}:${key}`;
    const cached = idempotencyStore.get(storeKey);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        res.setHeader('X-Cache-Lookup', 'IDEMPOTENT_HIT');
        return res.status(cached.statusCode).json(cached.body);
      }
      idempotencyStore.delete(storeKey);
    }

    // Intercept res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        idempotencyStore.set(storeKey, {
          statusCode: res.statusCode,
          body,
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        });
      }
      return originalJson(body);
    };

    next();
  };
}
