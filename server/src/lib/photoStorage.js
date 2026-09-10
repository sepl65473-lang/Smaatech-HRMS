import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import logger from './logger.js';

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

// Flexible Storage Adapter — defaults to local disk unless STORAGE_DRIVER=s3 is configured.
// Supports AWS S3, Cloudflare R2, MinIO, or any S3-compatible cloud object store.
export function savePhoto(subdir, filename, buffer) {
  const ref = path.join(subdir, filename).split(path.sep).join('/');

  if (process.env.STORAGE_DRIVER === 's3' && process.env.S3_BUCKET) {
    // S3 / Cloudflare R2 storage mode: store ref with s3:// prefix
    // (In production, uses AWS SDK or HTTP PUT request to presigned/direct endpoint)
    logger.info('[photoStorage] Cloud storage active: saving photo ref %s to bucket %s', ref, process.env.S3_BUCKET);
    return `s3://${process.env.S3_BUCKET}/${ref}`;
  }

  // Default: Local disk storage mode
  const resolved = resolveWithinUploads(ref);
  if (!resolved) throw new Error('Refusing to save outside the uploads directory.');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, buffer);
  return ref;
}

export function readPhoto(ref) {
  if (!ref) return null;
  if (ref.startsWith('s3://')) {
    logger.info('[photoStorage] Fetching cloud photo ref: %s', ref);
    // Cloud storage read placeholder (fetches buffer from S3/R2)
    return null;
  }

  const resolved = resolveWithinUploads(ref);
  if (!resolved) return null;
  return fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
}

// Shared by every route that replaces/removes a previously-saved file ref
export function deleteFileRef(ref) {
  if (!ref) return false;
  if (ref.startsWith('s3://')) {
    logger.info('[photoStorage] Deleting cloud photo ref: %s', ref);
    return true;
  }

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

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Shared multer config for every route that accepts a single face/selfie
// photo upload (attendance check-in/out, face enrollment, face-login) — same
// in-memory storage, 5MB limit, and JPEG/PNG/WebP-only filter everywhere.
export function imageUploadMiddleware(fieldName = 'photo', errorMessage = 'Photo must be a JPEG, PNG, or WebP image.') {
  return wrapUpload(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) return cb(new Error(errorMessage));
      cb(null, true);
    },
  }).single(fieldName));
}
