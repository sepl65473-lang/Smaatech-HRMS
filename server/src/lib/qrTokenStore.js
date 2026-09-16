import crypto from 'node:crypto';
import { putShared, takeShared } from './sharedStore.js';

// Single-use, short-TTL token store for the office QR display — replaces the
// old client-only Math.random() token the server never issued or validated.
//
// This used to be an in-process Map, with a comment reasoning that the app runs
// as a single Node process. That is no longer a safe assumption: with
// ENABLE_CLUSTER / WEB_CONCURRENCY, or two Render instances, a token issued by
// one worker is invisible to the others — so the same scan could be replayed
// once per worker, which is exactly what "single use" is supposed to prevent.
// It is now held in the shared store (lib/sharedStore.js), where consuming a
// token is one atomic delete.
const TOKEN_TTL_MS = 12 * 1000; // slightly longer than the display's 10s rotation
const KEY_PREFIX = 'qr:';

export async function issueQrToken(company) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  await putShared(`${KEY_PREFIX}${token}`, { company, expiresAt }, TOKEN_TTL_MS);
  return { token, expiresAt };
}

// Single-use: a valid token is consumed on first check, so the same scan cannot
// be replayed even inside its TTL window — and, because the read and the delete
// are one command, not by a second worker either.
export async function consumeQrToken(token, company) {
  if (!token) return false;
  const entry = await takeShared(`${KEY_PREFIX}${token}`);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) return false;
  if (entry.company !== company) return false;
  return true;
}
