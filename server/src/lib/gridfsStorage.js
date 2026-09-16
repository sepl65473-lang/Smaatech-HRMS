import mongoose from 'mongoose';
import crypto from 'node:crypto';
import logger from './logger.js';

/**
 * File storage on the MongoDB this project ALREADY uses.
 *
 * WHY: the deployed storage is Render's local disk, which is ephemeral — every
 * attendance selfie, face-enrolment photo and uploaded document is lost on the
 * next deploy. The previous code carried an `s3://` branch, but it was a stub
 * that returned a fabricated ref without uploading anything, and no S3
 * variables exist in render.yaml or the project's .env. So S3 was never the
 * storage provider here; local disk was.
 *
 * GridFS fixes durability WITHOUT adding a vendor: it is part of MongoDB,
 * which this project already runs on Atlas with a replica set. Files are
 * chunked into the same database, inherit its backups and its access control,
 * and there is no new credential, bucket, region or billing relationship.
 *
 * Trade-offs, stated honestly:
 *   - It consumes Atlas storage, which is costlier per GB than object storage.
 *     For attendance selfies (~25KB) and HR documents this is small; for heavy
 *     video it would not be the right choice.
 *   - Reads stream through the app rather than being served by a CDN.
 * If those become real constraints, an S3-compatible provider is a reasonable
 * future option — but that is a BUSINESS DECISION about a new provider, not
 * something to adopt silently.
 */

const BUCKET_NAME = process.env.GRIDFS_BUCKET || 'hrmsfiles';

function bucket() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('GridFS unavailable: no active MongoDB connection.');
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}

/** Refs are `gridfs://<bucket>/<filename>` so they are self-describing. */
export function isGridFsRef(ref) {
  return typeof ref === 'string' && ref.startsWith('gridfs://');
}

function parseRef(ref) {
  const rest = ref.slice('gridfs://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return { bucketName: rest.slice(0, slash), filename: rest.slice(slash + 1) };
}

export async function saveToGridFs(subdir, filename, buffer, { contentType = 'application/octet-stream', metadata = {} } = {}) {
  const storedName = `${subdir}/${filename}`.replace(/^\/+/, '');

  return new Promise((resolve, reject) => {
    const stream = bucket().openUploadStream(storedName, {
      contentType,
      metadata: { ...metadata, uploadedAt: new Date() },
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(`gridfs://${BUCKET_NAME}/${storedName}`));
    stream.end(buffer);
  });
}

export async function readFromGridFs(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return null;

  const files = await mongoose.connection.db
    .collection(`${parsed.bucketName}.files`)
    .findOne({ filename: parsed.filename }, { sort: { uploadDate: -1 } });
  if (!files) return null;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: parsed.bucketName })
      .openDownloadStream(files._id);
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', (err) => {
      // A missing file is a 404 for the caller, not an outage.
      if (err?.code === 'ENOENT' || /FileNotFound/i.test(err.message)) return resolve(null);
      reject(err);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function deleteFromGridFs(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  try {
    const b = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: parsed.bucketName });
    const files = await mongoose.connection.db
      .collection(`${parsed.bucketName}.files`)
      .find({ filename: parsed.filename }).toArray();
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      await b.delete(f._id);
    }
    return files.length > 0;
  } catch (err) {
    logger.warn('[gridfs] delete failed for %s: %s', ref, err.message);
    return false;
  }
}

/**
 * Short-lived, signed retrieval token.
 *
 * GridFS has no pre-signed URL of its own, so this mints an HMAC token the
 * file route verifies. It is bound to the specific ref and expires, so a
 * leaked link stops working — the same property a pre-signed object URL has.
 * Signed with JWT_ACCESS_SECRET, which the app already requires at boot.
 */
export function signRefToken(ref, ttlSeconds = 300) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) return null;
  const expiresAt = Date.now() + Math.min(Math.max(ttlSeconds, 30), 3600) * 1000;
  const payload = `${ref}|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyRefToken(token) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const sep = payload.lastIndexOf('|');
  const ref = payload.slice(0, sep);
  const expiresAt = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  return ref;
}

/** Total bytes held, for the storage panel and capacity planning. */
export async function gridFsUsage() {
  if (mongoose.connection.readyState !== 1) return null;
  const stats = await mongoose.connection.db.collection(`${BUCKET_NAME}.files`)
    .aggregate([{ $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: '$length' } } }])
    .toArray();
  return stats[0] ? { files: stats[0].files, bytes: stats[0].bytes } : { files: 0, bytes: 0 };
}

export { BUCKET_NAME };
