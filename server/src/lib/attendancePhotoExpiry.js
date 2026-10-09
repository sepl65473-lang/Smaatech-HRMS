import mongoose from 'mongoose';
import logger from './logger.js';

/**
 * Attendance check-in / check-out photos are kept for 24 hours and then
 * permanently deleted. Nothing else is.
 *
 * How a photo becomes eligible: when a SUCCESSFUL punch photo is stored (the
 * `attendance/<employeeId>/...` folder), its GridFS file is stamped with
 * `metadata.expiresAt`. Only a file that carries that stamp, and whose name is
 * under `attendance/`, is ever refused or deleted here. That is what keeps
 * everything else out of reach by construction:
 *   - photos stored before this policy existed have no stamp, so they stay;
 *   - `enrollment/` (face enrolment), `attendance-failed/` (rejected
 *     attempts), `documents/` and any other file are never stamped and never
 *     match the folder check.
 * The attendance record itself is not touched: its times, location, status
 * and photo reference stay exactly as written.
 */
export const ATTENDANCE_PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
const ATTENDANCE_FOLDER = 'attendance/';
const BUCKET_NAME = process.env.GRIDFS_BUCKET || 'hrmsfiles';

/** True for the folder successful punch photos are saved under, and only that. */
export function isAttendancePhotoPath(storedName) {
  return typeof storedName === 'string' && storedName.startsWith(ATTENDANCE_FOLDER);
}

/** Metadata to stamp on a file being saved under `subdir`; empty for anything but an attendance photo. */
export function expiryMetadataFor(subdir, now = Date.now()) {
  const folder = `${String(subdir || '').replace(/^\/+/, '')}/`;
  return isAttendancePhotoPath(folder) ? { expiresAt: new Date(now + ATTENDANCE_PHOTO_TTL_MS) } : {};
}

function storedNameOf(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('gridfs://')) return null;
  const rest = ref.slice('gridfs://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1 || rest.slice(0, slash) !== BUCKET_NAME) return null;
  return rest.slice(slash + 1);
}

/**
 * When the attendance photo behind `ref` expires, or null when it has no
 * expiry (an older photo, a non-attendance file, or a file that is not there).
 */
export async function attendancePhotoExpiry(ref) {
  const storedName = storedNameOf(ref);
  if (!storedName || !isAttendancePhotoPath(storedName)) return null;
  if (mongoose.connection.readyState !== 1) return null;
  const file = await mongoose.connection.db.collection(`${BUCKET_NAME}.files`)
    .findOne({ filename: storedName }, { sort: { uploadDate: -1 }, projection: { metadata: 1 } });
  const expiresAt = file?.metadata?.expiresAt;
  return expiresAt instanceof Date ? expiresAt : null;
}

/**
 * Permanently deletes attendance photos whose 24 hours are up: the GridFS file
 * document and every one of its chunks. Runs from the scheduler every 15
 * minutes and from the internal job endpoint. It works from the expiry stored
 * on each file, so a restart or a deploy changes nothing about what is due.
 */
export async function purgeExpiredAttendancePhotos({ now = new Date(), limit = 500 } = {}) {
  if (mongoose.connection.readyState !== 1) return { skipped: true, reason: 'database not connected', deleted: 0 };
  const db = mongoose.connection.db;
  const files = db.collection(`${BUCKET_NAME}.files`);
  const chunks = db.collection(`${BUCKET_NAME}.chunks`);
  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });

  const due = await files.find({
    filename: { $regex: '^attendance/' },
    'metadata.expiresAt': { $type: 'date', $lte: now },
  }).project({ filename: 1, metadata: 1 }).limit(limit).toArray();

  let deleted = 0;
  let failed = 0;
  for (const file of due) {
    // Checked again on the document in hand, so a query mistake could never
    // widen what is removed.
    const expiresAt = file.metadata?.expiresAt;
    if (!isAttendancePhotoPath(file.filename) || !(expiresAt instanceof Date) || expiresAt > now) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(file._id);
      // bucket.delete removes the chunks too; this makes sure none are left
      // behind if an earlier attempt was interrupted part-way.
      // eslint-disable-next-line no-await-in-loop
      await chunks.deleteMany({ files_id: file._id });
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.warn('[attendance-photos] could not delete %s: %s', file.filename, err.message);
    }
  }
  if (deleted || failed) logger.info('[attendance-photos] expired photos deleted: %d, failed: %d', deleted, failed);
  return { deleted, failed, checked: due.length };
}
