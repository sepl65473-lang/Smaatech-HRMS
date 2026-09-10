const cacheMap = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function getCache(key) {
  const item = cacheMap.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cacheMap.delete(key);
    return null;
  }
  return item.value;
}

export function setCache(key, value, ttlMs = DEFAULT_TTL_MS) {
  cacheMap.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export function invalidateCache(prefixOrKey) {
  for (const key of cacheMap.keys()) {
    if (key === prefixOrKey || key.startsWith(prefixOrKey)) {
      cacheMap.delete(key);
    }
  }
}
