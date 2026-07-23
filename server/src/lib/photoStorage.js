import fs from 'node:fs';
import path from 'node:path';

const UPLOADS_ROOT = path.resolve(import.meta.dirname, '../../uploads');

// A bare `resolved.startsWith(UPLOADS_ROOT)` string check wrongly accepts a
// sibling directory like "uploads-evil" (its path also starts with the
// "uploads" prefix) — require an exact match or the root followed by a
// path separator instead.
function resolveWithinUploads(ref) {
  const resolved = path.join(UPLOADS_ROOT, ref);
  if (resolved !== UPLOADS_ROOT && !resolved.startsWith(UPLOADS_ROOT + path.sep)) return null;
  return resolved;
}

// Stores a photo to local disk (behind an adapter-shaped function so this is
// the one place to change if this ever moves to S3-compatible storage).
// Returns a relative ref (not an absolute path) — never a public URL,
// since these are biometric-adjacent personal photos served only through
// the authenticated /files route.
export function savePhoto(subdir, filename, buffer) {
  const ref = path.join(subdir, filename);
  const resolved = resolveWithinUploads(ref);
  if (!resolved) throw new Error('Refusing to save outside the uploads directory.');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, buffer);
  return ref.split(path.sep).join('/');
}

export function readPhoto(ref) {
  const resolved = resolveWithinUploads(ref);
  if (!resolved) return null;
  return fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
}

// Shared by every route that replaces/removes a previously-saved file ref —
// callers must never resolve+unlink a ref themselves (that was the source of
// an unguarded-delete bug in the documents route).
export function deleteFileRef(ref) {
  if (!ref) return false;
  const resolved = resolveWithinUploads(ref);
  if (!resolved) return false;
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    return true;
  } catch (err) {
    console.warn('[photoStorage] failed to delete file:', err.message);
    return false;
  }
}

// multer's fileFilter rejection (or a size-limit breach) is an error passed
// to Express's error-handling middleware by default, which would otherwise
// surface as an opaque 500 — wrap the middleware so uploads routes can give
// a proper 400 with the actual reason instead.
export function wrapUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ error: { code: 'INVALID_FILE', message: err.message } });
      next();
    });
  };
}
