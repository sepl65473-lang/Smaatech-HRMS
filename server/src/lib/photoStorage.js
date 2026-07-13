import fs from 'node:fs';
import path from 'node:path';

const UPLOADS_ROOT = path.resolve(import.meta.dirname, '../../uploads');

// Stores a photo to local disk (behind an adapter-shaped function so this is
// the one place to change if this ever moves to S3-compatible storage).
// Returns a relative ref (not an absolute path) — never a public URL,
// since these are biometric-adjacent personal photos served only through
// the authenticated /files route.
export function savePhoto(subdir, filename, buffer) {
  const dir = path.join(UPLOADS_ROOT, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const ref = path.join(subdir, filename);
  fs.writeFileSync(path.join(UPLOADS_ROOT, ref), buffer);
  return ref.split(path.sep).join('/');
}

export function readPhoto(ref) {
  const resolved = path.join(UPLOADS_ROOT, ref);
  if (!resolved.startsWith(UPLOADS_ROOT)) return null; // guard against path traversal
  return fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
}
