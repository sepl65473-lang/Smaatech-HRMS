import { Router } from 'express';
import { requireInternalAccess } from '../middleware/internalAuth.js';
import logger from '../lib/logger.js';
import { createTodaysAttendanceRows, notifyYesterdaysAbsences } from '../lib/attendanceDailyJob.js';
import { flagMissingCheckouts } from '../lib/jobs.js';
import { sendAttendanceReminders } from '../lib/attendanceReminderJob.js';
import { purgeExpiredAttendancePhotos } from '../lib/attendancePhotoExpiry.js';

/**
 * A second way to run the DAILY ATTENDANCE JOBS THAT ALREADY EXIST.
 *
 * WHY: the in-process cron in lib/jobs.js only fires while the process is
 * running, and this API sleeps after 15 idle minutes on its current plan. A
 * night with no traffic is a night the 00:05 job never runs, and the live
 * database shows exactly that — 13 of the 31 days to 20 Sep 2026 have no
 * attendance rows at all.
 *
 * This endpoint calls THE SAME job functions. It does not reimplement them,
 * does not change their timing, and does not replace the scheduler, which
 * keeps running as before. Both can fire on the same day safely:
 * createTodaysAttendanceRows() inserts only for employees who have no row for
 * that date, so a second run is a no-op rather than a duplicate. Nothing here
 * writes historical days.
 */
const router = Router();

router.post('/daily-attendance', requireInternalAccess, async (req, res) => {
  const startedAt = Date.now();
  const via = req.internalAuth?.via || 'session';
  logger.info('[jobs] daily-attendance triggered externally (via %s)', via);

  const results = {};
  for (const [name, job] of [
    ['createTodaysAttendanceRows', createTodaysAttendanceRows],
    ['flagMissingCheckouts', flagMissingCheckouts],
    ['notifyYesterdaysAbsences', notifyYesterdaysAbsences],
  ]) {
    try {
      // Each job is independent: one failing must not stop the others, since
      // the point of this path is redundancy.
      // eslint-disable-next-line no-await-in-loop
      const out = await job();
      results[name] = { ok: true, ...(out && typeof out === 'object' ? out : {}) };
    } catch (err) {
      logger.error('[jobs] %s failed on external trigger: %s', name, err.message);
      results[name] = { ok: false, error: err.message };
    }
  }

  const failed = Object.values(results).some((r) => !r.ok);
  res.status(failed ? 500 : 200).json({ ok: !failed, via, ms: Date.now() - startedAt, results });
});

/**
 * The same redundancy for the same-day attendance reminders
 * (lib/attendanceReminderJob.js). The job checks the cutoff times and sends
 * each reminder at most once per employee per day, so an extra call — or one
 * arriving before the cutoff — sends nothing it should not.
 */
router.post('/attendance-reminders', requireInternalAccess, async (req, res) => {
  const startedAt = Date.now();
  const via = req.internalAuth?.via || 'session';
  logger.info('[jobs] attendance-reminders triggered externally (via %s)', via);
  try {
    const result = await sendAttendanceReminders();
    res.json({ ok: true, via, ms: Date.now() - startedAt, result });
  } catch (err) {
    logger.error('[jobs] attendance-reminders failed on external trigger: %s', err.message);
    res.status(500).json({ ok: false, via, ms: Date.now() - startedAt, error: err.message });
  }
});

/**
 * The same redundancy for the 24-hour attendance photo cleanup
 * (lib/attendancePhotoExpiry.js). An extra call is harmless: the job deletes
 * only files whose own stored expiry has passed, so a second run finds
 * nothing left to do.
 */
router.post('/attendance-photo-cleanup', requireInternalAccess, async (req, res) => {
  const startedAt = Date.now();
  const via = req.internalAuth?.via || 'session';
  logger.info('[jobs] attendance-photo-cleanup triggered externally (via %s)', via);
  try {
    const result = await purgeExpiredAttendancePhotos();
    res.json({ ok: true, via, ms: Date.now() - startedAt, result });
  } catch (err) {
    logger.error('[jobs] attendance-photo-cleanup failed on external trigger: %s', err.message);
    res.status(500).json({ ok: false, via, ms: Date.now() - startedAt, error: err.message });
  }
});

export default router;
