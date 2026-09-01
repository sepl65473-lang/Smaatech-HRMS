import crypto from 'node:crypto';

// In-memory, single-use, short-TTL token store for the office QR display —
// replaces the old client-only Math.random() token that the server never
// issued or validated at all. Fine as in-memory (not persisted) since a
// token's whole purpose is to expire in seconds; this app runs as a single
// Node process (see README's "why Render, not serverless" section), so
// there's no multi-instance consistency concern to worry about here.
const TOKEN_TTL_MS = 12 * 1000; // slightly longer than the display's 10s rotation
const tokens = new Map(); // token -> { company, expiresAt }

function sweep() {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}

export function issueQrToken(company) {
  sweep();
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokens.set(token, { company, expiresAt });
  return { token, expiresAt };
}

// Single-use: a valid token is consumed (deleted) on first successful check,
// so the same scan can't be replayed even within its TTL window.
export function consumeQrToken(token, company) {
  const entry = tokens.get(token);
  if (!entry) return false;
  tokens.delete(token);
  if (entry.expiresAt < Date.now()) return false;
  if (entry.company !== company) return false;
  return true;
}
