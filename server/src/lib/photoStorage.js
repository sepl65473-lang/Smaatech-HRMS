import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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

// ── Storage driver selection ──────────────────────────────────────────────
//
// THIS PROJECT'S PROVIDERS, and nothing else:
//   'local'  — disk under server/uploads. Fine for development. EPHEMERAL on
//              Render, so every uploaded file is lost on the next deploy.
//   'gridfs' — the MongoDB this project already runs on. Durable, backed up
//              with the rest of the database, no new vendor, no new credential.
//
// An earlier revision of this file wired in the AWS SDK. That was wrong: the
// original code only ever had a non-functional `s3://` placeholder, and no S3
// variables exist in render.yaml or in this project's .env — the deployed
// storage has always been local disk. Adding AWS would have introduced a cloud
// provider this project does not use. It has been removed.
//
// If object storage is ever genuinely wanted (cost at volume, CDN delivery),
// that is a STORAGE PROVIDER / BUSINESS DECISION, not something to adopt
// silently. `STORAGE_DRIVER=s3` therefore refuses to start rather than
// pretending to work — which is exactly the silent data loss that existed
// before.
export function resolveStorageDriver(env = process.env) {
  const configured = (env.STORAGE_DRIVER || '').toLowerCase();
  if (configured === 's3') {
    throw new Error(
      'STORAGE_DRIVER=s3 is not implemented in this project. This HRMS stores files on '
      + 'local disk (development) or in MongoDB GridFS (production, STORAGE_DRIVER=gridfs). '
      + 'Adopting an object-storage provider is a business decision — see lib/gridfsStorage.js.',
    );
  }
  if (configured === 'gridfs') return 'gridfs';
  if (configured === 'local') return 'local';

  // PRODUCTION DEFAULTS TO DURABLE. The container filesystem is wiped on every
  // deploy and every wake from sleep, so an unset variable used to mean
  // "attendance selfies disappear" — and in this deployment it did: the rows
  // still carry a photo ref while the file behind it is gone. GridFS needs no
  // new provider or credential; it is the MongoDB this service already runs.
  // ALLOW_EPHEMERAL_STORAGE=1 keeps the old behaviour for anyone who wants it.
  if (env.NODE_ENV === 'production' && !env.ALLOW_EPHEMERAL_STORAGE) return 'gridfs';
  return 'local';
}

export function storageDriver() {
  return resolveStorageDriver(process.env);
}

export function isDurableStorage() {
  return storageDriver() === 'gridfs';
}

// Extension -> media type. Also doubles as the allow-list safeExtension()
// checks against, so a client-supplied filename can never introduce a type
// this app does not knowingly serve.
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function contentTypeForRef(ref) {
  return CONTENT_TYPES[path.extname(ref || '').toLowerCase()] || 'application/octet-stream';
}

// Returns an opaque storage ref. Async because a real object-store write is.
export async function savePhoto(subdir, filename, buffer) {
  const ref = path.join(subdir, filename).split(path.sep).join('/');

  if (storageDriver() === 'gridfs') {
    const { saveToGridFs } = await import('./gridfsStorage.js');
    return saveToGridFs(subdir, filename, buffer, { contentType: contentTypeForRef(ref) });
  }

  const resolved = resolveWithinUploads(ref);
  if (!resolved) throw new Error('Refusing to save outside the uploads directory.');
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, buffer);
  return ref;
}

export async function readPhoto(ref) {
  if (!ref) return null;

  if (ref.startsWith('gridfs://')) {
    const { readFromGridFs } = await import('./gridfsStorage.js');
    return readFromGridFs(ref);
  }
  // A ref written by the old non-functional S3 stub. The bytes were never
  // uploaded anywhere, so it can only be reported missing — saying so plainly
  // beats a confusing failure further up.
  if (ref.startsWith('s3://')) {
    logger.warn('[photoStorage] legacy s3:// ref has no stored bytes (the old driver never uploaded): %s', ref);
    return null;
  }

  const resolved = resolveWithinUploads(ref);
  if (!resolved) return null;
  try {
    return await fsp.readFile(resolved);
  } catch {
    return null;
  }
}

// Time-limited signed retrieval token.
//
// Object storage would give a pre-signed URL; GridFS has no equivalent, so
// this mints an HMAC token bound to the ref and expiring on a deadline, which
// the file routes verify. Only ever issued AFTER the caller has passed the
// same authorization check that guards the streaming download.
export async function getSignedDownloadUrl(ref, { expiresInSeconds = 300 } = {}) {
  if (!ref || !ref.startsWith('gridfs://')) return null;
  const { signRefToken } = await import('./gridfsStorage.js');
  return signRefToken(ref, expiresInSeconds);
}

export async function deleteFileRef(ref) {
  if (!ref) return false;

  if (ref.startsWith('gridfs://')) {
    const { deleteFromGridFs } = await import('./gridfsStorage.js');
    return deleteFromGridFs(ref);
  }
  if (ref.startsWith('s3://')) return false; // legacy stub ref; nothing stored

  const resolved = resolveWithinUploads(ref);
  if (!resolved) return false;
  try {
    await fsp.rm(resolved, { force: true });
    return true;
  } catch (err) {
    logger.warn('[photoStorage] failed to delete file: %s', err.message);
    return false;
  }
}

// Called once at boot. A container or serverless filesystem is ephemeral, so
// running production on the local driver means every uploaded file vanishes
// on the next deploy — loud at startup beats silent data loss later.
// `env` is injectable so startup checks can validate a candidate environment
// (and be tested) without mutating process.env.
export function assertStorageConfigured(env = process.env) {
  const configured = (env.STORAGE_DRIVER || '').toLowerCase();

  if (configured === 's3') {
    throw new Error(
      'STORAGE_DRIVER=s3 is not implemented in this project. Use gridfs (MongoDB, durable) '
      + 'or local (development only). Adopting object storage is a business decision.',
    );
  }

  if (resolveStorageDriver(env) === 'gridfs') {
    logger.info('[photoStorage] durable storage: MongoDB GridFS (bucket %s)', env.GRIDFS_BUCKET || 'hrmsfiles');
    return { driver: 'gridfs', durable: true };
  }

  if (env.NODE_ENV === 'production' && !env.ALLOW_EPHEMERAL_STORAGE) {
    logger.warn(
      '[photoStorage] DURABILITY WARNING: local disk storage in production. On Render this '
      + 'filesystem is EPHEMERAL — attendance photos and documents are LOST on every deploy. '
      + 'Set STORAGE_DRIVER=gridfs to store them durably in the MongoDB you already run, '
      + 'or ALLOW_EPHEMERAL_STORAGE=1 to acknowledge the risk.',
    );
  }
  return { driver: 'local', durable: false };
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

// Magic-byte sniffing. A client fully controls the multipart Content-Type
// header that multer's fileFilter sees, so a mime allow-list on its own lets
// an arbitrary payload through labelled "image/jpeg". This reads the actual
// leading bytes of the received buffer instead.
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Never derive a stored filename from client-supplied originalname.
export function safeExtension(originalName, fallback = '.bin') {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) && ext in CONTENT_TYPES ? ext : fallback;
}

export function randomFilename(ext) {
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
}

// Shared multer config for every route that accepts a single face/selfie
// photo upload (attendance check-in/out, face enrollment, face-login) — same
// in-memory storage, 5MB limit, and JPEG/PNG/WebP-only filter everywhere.
export function imageUploadMiddleware(fieldName = 'photo', errorMessage = 'Photo must be a JPEG, PNG, or WebP image.') {
  return wrapUpload(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 25 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) return cb(new Error(errorMessage));
      cb(null, true);
    },
  }).single(fieldName));
}

export { UPLOADS_ROOT };
