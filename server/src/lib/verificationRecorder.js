import VerificationAttempt from '../models/VerificationAttempt.js';
import Attendance from '../models/Attendance.js';
import { savePhoto, randomFilename } from './photoStorage.js';
import { parseDeviceInfo, clientIp } from './deviceInfo.js';
import { todayISO } from './dateUtils.js';
import { nowTimeIST } from './shifts.js';
import logger from './logger.js';

/**
 * Records a REJECTED attendance verification attempt, with its photo.
 *
 * Every rejection path in the punch flow funnels through here so that a
 * failure produces the same evidence regardless of which check caught it:
 * the capture, the reason, who was signed in, where they were, and on what
 * device. Before this, a failed face match wrote a single AuditLog line, threw
 * the photo away, and was invisible to the HR Managers who actually run
 * attendance (AuditLog is HR-Director-only).
 *
 * Never throws: a failure to record evidence must not change the outcome the
 * user sees, and must not turn a clean 400 into a 500.
 */
export async function recordFailedAttempt(req, {
  row = null,
  direction,
  stage,
  reasonCode,
  reasonMessage = '',
  photoBuffer = null,
  faceDistance = null,
  faceConfidence = null,
  geo = null,
  gpsResult = null,
  deviceId = null,
}) {
  try {
    const company = req.auth?.company || 'Smaatech';
    const empId = row?.empId || (req.auth?.employeeId || null);

    // The capture is the evidence — without it "someone else's face" is an
    // unprovable assertion. Stored through the same private-bucket path as
    // every other biometric image.
    let photoRef = null;
    if (photoBuffer) {
      try {
        photoRef = await savePhoto(
          `attendance-failed/${empId || req.auth?.sub || 'unknown'}`,
          randomFilename('.jpg'),
          photoBuffer,
        );
      } catch (err) {
        logger.warn('[verification] could not retain rejected-attempt photo: %s', err.message);
      }
    }

    const attempt = await VerificationAttempt.create({
      company,
      userId: req.auth?.sub,
      empId,
      employeeName: row?.name || req.auth?.name || '',
      date: todayISO(),
      time: nowTimeIST(),
      direction,
      stage,
      reasonCode,
      reasonMessage,
      faceDistance,
      faceConfidence,
      photoRef,
      location: {
        placeName: geo?.placeName || null,
        fullAddress: geo?.fullAddress || null,
        pincode: geo?.pincode || null,
        city: geo?.city || null,
        state: geo?.state || null,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        accuracy: geo?.accuracy ?? null,
        distanceFromOffice: gpsResult?.distance ?? null,
      },
      deviceId,
      device: parseDeviceInfo(req.headers['user-agent']),
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    });

    // Surface the count on the attendance row itself, so HR sees "3 failed
    // attempts" on the record without opening another screen.
    if (row?._id) {
      await Attendance.updateOne(
        { _id: row._id },
        {
          $inc: { failedVerificationCount: 1 },
          $addToSet: { anomalyFlags: 'failed-verification' },
        },
      );
    }

    return attempt;
  } catch (err) {
    logger.error('[verification] failed to record rejected attempt: %o', err);
    return null;
  }
}

/**
 * Per-employee-day count of recent rejections, used to slow down repeated
 * spoofing attempts without locking anyone out of their own attendance.
 */
export async function recentFailureCount({ company, userId, windowMinutes = 15 }) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  return VerificationAttempt.countDocuments({ company, userId, createdAt: { $gte: since } });
}
