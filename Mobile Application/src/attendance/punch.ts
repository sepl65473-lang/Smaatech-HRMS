import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { attendanceApi, faceApi } from '../services/endpoints';
import { ApiError } from '../services/api';
import { getDeviceId } from '../storage/secure';
import { todayIST } from '../utils/date';
import type { Fix } from '../permissions/location';
import type { Attendance } from '../types';

// The server decodes with a JPEG-only decoder that ignores EXIF orientation
// (routes/attendance.js, lib/faceEngine.js). Re-rendering here bakes the
// rotation into the pixels and brings a multi-megabyte camera frame down to a
// size that uploads quickly on mobile data, well inside the 5 MB limit.
const UPLOAD_WIDTH = 720;
// A liveness burst is several frames that the server decodes and analyses one
// after another, so each is sent smaller. The face still fills most of the
// frame, well above what detection and matching need.
export const LIVENESS_FRAME_WIDTH = 480;

export async function prepareFrame(uri: string, width: number = UPLOAD_WIDTH): Promise<string> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width }).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  return saved.uri;
}

function appendJpeg(form: FormData, field: string, uri: string, name: string) {
  // Expo's fetch (the global fetch in this SDK) does not accept React Native's
  // path-based `{ uri, name, type }` file part: it throws while building the
  // request, before anything is sent. It takes a part that can hand over its
  // bytes, with the filename and content type read from `name` and `type`.
  // The server accepts only image/jpeg, so the type is stated, not inferred.
  const file = new File(uri);
  form.append(field, { name, type: 'image/jpeg', bytes: () => file.bytes() } as unknown as Blob);
}

export interface PunchInput {
  attendanceId: string;
  direction: 'in' | 'out';
  /** One frame normally; an ordered burst when liveness is required. */
  frames: string[];
  challengeId?: string;
  fix: Fix;
  /** Check-out before 6:00 PM: the reason chosen, and the text when it is "Other". */
  earlyCheckout?: { reason: string; note?: string } | null;
}

// Reasons offered for a check-out before 6:00 PM. The server holds the same
// list (server/src/routes/attendance.js) and is the one that enforces it.
export const EARLY_CHECKOUT_REASONS = [
  'Personal emergency',
  'Medical reason',
  'Family/personal work',
  'Official work outside office',
  'Approved permission',
  'Transport/travel issue',
  'Other',
];

/**
 * Submits a self check-in/out. The photo, the raw coordinates and the device
 * id are all the client contributes: face match, liveness, geofence, shift
 * rules and the recorded time are decided by the server, and only its
 * response counts as success.
 */
export async function submitPunch(input: PunchInput): Promise<Attendance> {
  const form = new FormData();
  form.append('lat', String(input.fix.lat));
  form.append('lng', String(input.fix.lng));
  if (input.fix.accuracy != null) form.append('accuracy', String(input.fix.accuracy));
  form.append('timestamp', String(input.fix.timestamp));
  form.append('deviceId', await getDeviceId());
  if (input.earlyCheckout?.reason) {
    form.append('earlyCheckoutReason', input.earlyCheckout.reason);
    if (input.earlyCheckout.note) form.append('earlyCheckoutNote', input.earlyCheckout.note);
  }
  if (input.challengeId) {
    form.append('challengeId', input.challengeId);
    input.frames.forEach((uri, index) => appendJpeg(form, 'frames', uri, `frame-${index}.jpg`));
  } else {
    appendJpeg(form, 'photo', input.frames[0]!, `check-${input.direction}.jpg`);
  }
  return attendanceApi.punch(input.attendanceId, input.direction, form);
}

/**
 * After a timeout or dropped connection the upload may still have landed.
 * Asks the server what it actually holds instead of guessing either way.
 */
export async function findRecordedPunch(employeeId: string, direction: 'in' | 'out'): Promise<Attendance | null> {
  try {
    const today = todayIST();
    const { rows } = await attendanceApi.forEmployee(employeeId, today, today);
    const row = rows[0];
    if (!row) return null;
    return (direction === 'in' ? row.checkIn : row.checkOut) ? row : null;
  } catch {
    return null;
  }
}

export async function submitEnrollment(uri: string) {
  const form = new FormData();
  appendJpeg(form, 'photo', uri, 'enroll.jpg');
  return faceApi.enroll(form);
}

// What to tell the user for each server verdict, with what they can do about
// it. Unknown codes fall back to the server's own message.
const ADVICE: Record<string, string> = {
  NO_FACE: 'Hold the phone at eye level in good light and keep your whole face inside the frame.',
  NO_FACE_DETECTED: 'Hold the phone at eye level in good light and keep your whole face inside the frame.',
  MULTIPLE_FACES: 'Make sure only you are in the frame.',
  FACE_NOT_MATCHED: 'Remove anything covering your face and try again in better light. If this keeps happening, ask HR to re-verify your face.',
  NOT_ENROLLED: 'Enrol your face from Profile before recording attendance.',
  OUTSIDE_GEOFENCE: 'Move to your office location and try again.',
  LOW_ACCURACY: 'Move outdoors or near a window so GPS can get a better reading.',
  STALE_FIX: 'Your location reading was too old. Try again.',
  CHECKOUT_TOO_EARLY: '',
  TOO_MANY_FAILED_ATTEMPTS: 'Verification is paused after several failed attempts. Wait about 15 minutes, then try again.',
  CHALLENGE_EXPIRED: 'Start again and follow the prompt promptly.',
  NO_HEAD_MOVEMENT: 'Start facing the screen. When the prompt says NOW, turn your head a little in the direction shown and hold it there until the photos finish.',
  WRONG_DIRECTION: 'Turn towards the side named in the prompt: your own left or your own right.',
  NO_BLINK_DETECTED: 'When the prompt says NOW, close your eyes for a full second, then open them.',
  EYES_NOT_MEASURABLE: 'Take off reflective glasses or move out of the glare, and look at the screen.',
  STATIC_IMAGE_REPLAY: 'Move as the prompt asks while the photos are being taken.',
  INCONSISTENT_FRAMES: 'Keep your face in the frame and move slowly.',
  FACE_TOO_SMALL: 'Hold the phone closer so your face fills the oval.',
};

export function punchFailure(err: unknown): { title: string; message: string; code: string } {
  if (err instanceof ApiError) {
    const advice = ADVICE[err.code];
    return {
      code: err.code,
      title: err.code === 'REQUEST_NOT_SENT' ? 'Could not send the photo'
        : err.isTransport ? 'Could not reach the server' : 'Not recorded',
      message: advice ? `${err.message}\n\n${advice}` : err.message,
    };
  }
  return { code: 'UNKNOWN', title: 'Not recorded', message: 'Something went wrong while submitting. Please try again.' };
}
