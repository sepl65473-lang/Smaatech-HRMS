import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import Leave from '../models/Leave.js';
import Settings from '../models/Settings.js';
import NotificationDelivery from '../models/NotificationDelivery.js';
import { sendEmail } from './mailer.js';
import { portalUrl } from './portalUrl.js';
import { nextAttemptDelay } from './notificationService.js';
import { resolveShiftForToday, nowTimeIST } from './shifts.js';
import { todayISO, calculateWorkingDays } from './dateUtils.js';
import { holidayDateSet } from './holidays.js';
import { processInNonBlockingBatches } from './jobQueue.js';
import { generateAttendanceReminderEmail } from './templates/attendanceReminderEmail.js';
import { connectDB } from '../db.js';
import logger from './logger.js';

/**
 * SAME-DAY ATTENDANCE REMINDERS, emailed to the employee only.
 *
 *   - No Check-In by the afternoon cutoff  -> "Check-In missing"
 *   - Check-In but no Check-Out by the end-of-day cutoff -> "Check-Out missing"
 *
 * Only ever looks at TODAY (IST, via todayISO()). Yesterday's absences and
 * orphaned check-outs stay with the existing next-day jobs
 * (attendanceDailyJob.js, jobs.js flagMissingCheckouts), which are unchanged.
 *
 * "Expected to work today" reuses the rules the rest of the system already
 * applies rather than inventing new ones:
 *   - employee status: exited / terminated / on-leave are skipped (jobs.js,
 *     attendanceDailyJob.js)
 *   - week-off and holidays: calculateWorkingDays() with Settings.workWeek and
 *     the company's Holiday list (the leave working-day calculation)
 *   - approved leave covering today, or a row already marked leave / holiday
 *   - the employee's shift (resolveShiftForToday, as the punch route uses): a
 *     later shift is not reminded before it has started or ended, and an
 *     overnight shift's check-out belongs to the next calendar day
 *
 * Duplicates are prevented by NotificationDelivery's unique
 * (company, dedupeKey, channel) index — one key per employee, event and date —
 * so the scheduler, the external trigger and any restart can all run this as
 * often as they like. A failed send is retried by THIS job (never the generic
 * retry pass), because it re-checks attendance first: an employee who checked
 * in after the first attempt failed must not then be told they haven't.
 */

export const REMINDER_TYPE = 'attendance-reminder';
export const EVENTS = { CHECK_IN: 'missing-checkin', CHECK_OUT: 'missing-checkout' };

const DEFAULTS = {
  checkInCutoff: '14:00',
  checkOutCutoff: '19:00',
  checkOutGraceMins: 60,
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm) => {
  const m = HHMM.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function readTime(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return toMinutes(fallback);
  const minutes = toMinutes(raw);
  if (minutes == null) {
    logger.warn('[attendance-reminders] %s="%s" is not a valid HH:MM time — using %s.', name, raw, fallback);
    return toMinutes(fallback);
  }
  return minutes;
}

export function reminderConfig() {
  const grace = Number(process.env.ATTENDANCE_CHECKOUT_GRACE_MINS);
  return {
    enabled: process.env.ATTENDANCE_REMINDERS_ENABLED !== 'false',
    checkInCutoff: readTime('ATTENDANCE_CHECKIN_CUTOFF', DEFAULTS.checkInCutoff),
    checkOutCutoff: readTime('ATTENDANCE_CHECKOUT_CUTOFF', DEFAULTS.checkOutCutoff),
    checkOutGraceMins: Number.isFinite(grace) && grace >= 0 ? grace : DEFAULTS.checkOutGraceMins,
  };
}

const emailConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.SMTP_USER);

/**
 * Which reminder (if any) this attendance row calls for at `nowMinutes`.
 * Pure — the eligibility checks (leave, holiday, status) happen before this.
 */
export function reminderDue(row, shift, nowMinutes, config) {
  const start = toMinutes(shift?.start);
  const end = toMinutes(shift?.end);
  const overnight = start != null && end != null && end <= start;

  if (!row?.checkIn) {
    const shiftDeadline = start != null ? start + (shift.graceMins || 0) : 0;
    const deadline = Math.max(config.checkInCutoff, shiftDeadline);
    return nowMinutes >= deadline ? EVENTS.CHECK_IN : null;
  }

  if (!row.checkOut) {
    // The check-out of a shift that crosses midnight happens tomorrow.
    if (overnight) return null;
    const shiftDeadline = end != null ? end + config.checkOutGraceMins : 0;
    const deadline = Math.max(config.checkOutCutoff, shiftDeadline);
    if (deadline >= 24 * 60) return null;
    return nowMinutes >= deadline ? EVENTS.CHECK_OUT : null;
  }

  return null;
}

const stillMissing = (event, row) => (event === EVENTS.CHECK_IN
  ? !row?.checkIn
  : Boolean(row?.checkIn) && !row?.checkOut);

const SKIP_ROW_STATUSES = ['leave', 'holiday'];

/**
 * Takes the right to send this reminder, or returns null when it has already
 * been sent, is being sent, or is waiting for its retry backoff.
 */
async function claimDelivery({ company, dedupeKey, recipientAddress, title, now }) {
  const existing = await NotificationDelivery.findOne({ company, dedupeKey, channel: 'email' });

  if (!existing) {
    try {
      return await NotificationDelivery.create({
        company, recipientAddress, channel: 'email', title, type: REMINDER_TYPE, dedupeKey, status: 'pending', lastAttemptAt: now,
      });
    } catch (err) {
      if (err.code === 11000) return null; // a concurrent run claimed it first
      throw err;
    }
  }

  // 'sent' is done; 'pending' is in flight (or its outcome is unknown — not
  // resending is the side that never duplicates); 'exhausted' needs a human.
  if (existing.status !== 'failed' || (existing.nextAttemptAt && existing.nextAttemptAt > now)) return null;

  // Atomic hand-off so two overlapping runs cannot both retry it.
  return NotificationDelivery.findOneAndUpdate(
    { _id: existing._id, status: 'failed', attempts: existing.attempts },
    { $set: { status: 'pending', lastAttemptAt: now, recipientAddress, title } },
    { new: true },
  );
}

async function deliver({ employee, event, date, company, orgName, now }) {
  // The latest record decides, not the snapshot the batch started from.
  const fresh = await Attendance.findOne({ empId: employee._id, date }).lean();
  if (fresh && SKIP_ROW_STATUSES.includes(fresh.status)) return 'skipped';
  if (!stillMissing(event, fresh)) return 'skipped';

  const { subject, text, html } = generateAttendanceReminderEmail({
    event,
    employeeName: employee.name,
    dateISO: date,
    checkIn: fresh?.checkIn || null,
    orgName,
    portalUrl: portalUrl(),
  });

  const record = await claimDelivery({
    company,
    dedupeKey: `${REMINDER_TYPE}:${event}:${employee._id}:${date}`,
    recipientAddress: employee.email,
    title: subject,
    now,
  });
  if (!record) return 'duplicate';

  try {
    await sendEmail({ to: employee.email, subject, text, html });
    await NotificationDelivery.updateOne(
      { _id: record._id },
      { $set: { status: 'sent', sentAt: new Date(), nextAttemptAt: null, lastError: '' }, $inc: { attempts: 1 } },
    );
    return 'sent';
  } catch (err) {
    const attempts = record.attempts + 1;
    const exhausted = attempts >= record.maxAttempts;
    await NotificationDelivery.updateOne(
      { _id: record._id },
      {
        $set: {
          attempts,
          status: exhausted ? 'exhausted' : 'failed',
          lastError: String(err?.message || err).slice(0, 500),
          nextAttemptAt: exhausted ? null : new Date(Date.now() + nextAttemptDelay(attempts)),
        },
      },
    );
    logger.error('[attendance-reminders] %s email to %s failed (attempt %d): %s', event, employee.email, attempts, err.message);
    return 'failed';
  }
}

const ELIGIBLE_EMPLOYEES = {
  status: { $nin: ['exited', 'terminated', 'on-leave'] },
  employmentStage: { $ne: 'Exited' },
  email: { $type: 'string', $gt: '' },
};

/**
 * Runs one pass over every company. Safe to call at any time and any number
 * of times: before the cutoffs it sends nothing, and each reminder goes out at
 * most once per employee per day.
 *
 * `date` and `time` exist for tests; production always uses today, now (IST).
 */
export async function sendAttendanceReminders({ date = todayISO(), time = nowTimeIST(), now = new Date() } = {}) {
  const config = reminderConfig();
  const summary = { date, time, sent: 0, failed: 0, duplicate: 0, skipped: 0 };

  if (!config.enabled) return { ...summary, disabled: true };

  const nowMinutes = toMinutes(time);
  if (nowMinutes < Math.min(config.checkInCutoff, config.checkOutCutoff)) return summary;

  if (!emailConfigured()) {
    // Nothing is recorded, so reminders start the moment email is configured.
    logger.warn('[attendance-reminders] BREVO_API_KEY/SMTP_USER are not set — no attendance reminders sent.');
    return { ...summary, emailNotConfigured: true };
  }

  await connectDB();
  const companies = await Employee.distinct('company', ELIGIBLE_EMPLOYEES);

  for (const company of companies) {
    // eslint-disable-next-line no-await-in-loop
    const settings = await Settings.findById(company).lean();
    // eslint-disable-next-line no-await-in-loop
    const holidays = await Holiday.find({ company }).lean();
    const holidaySet = holidayDateSet(holidays, Number(date.slice(0, 4)));
    // Week-off or holiday: nobody in this company is expected in today.
    if (calculateWorkingDays(date, date, settings?.workWeek || '5-day', holidaySet) === 0) continue;

    // eslint-disable-next-line no-await-in-loop
    const employees = await Employee.find({ company, ...ELIGIBLE_EMPLOYEES })
      .select('name email joinDate').lean();
    const empIds = employees.map((e) => e._id);

    // eslint-disable-next-line no-await-in-loop
    const [rows, onLeave] = await Promise.all([
      Attendance.find({ company, date, empId: { $in: empIds } }).select('empId checkIn checkOut status').lean(),
      Leave.distinct('empId', { company, status: 'approved', start: { $lte: date }, end: { $gte: date }, empId: { $in: empIds } }),
    ]);
    const rowByEmp = new Map(rows.map((r) => [String(r.empId), r]));
    const leaveSet = new Set(onLeave.map(String));

    const due = [];
    for (const employee of employees) {
      const id = String(employee._id);
      const row = rowByEmp.get(id);
      if (employee.joinDate && employee.joinDate > date) continue; // not started yet
      if (leaveSet.has(id) || (row && SKIP_ROW_STATUSES.includes(row.status))) continue;
      const event = reminderDue(row, resolveShiftForToday(id, settings), nowMinutes, config);
      if (event) due.push({ employee, event });
    }

    const orgName = settings?.orgName || company;
    // eslint-disable-next-line no-await-in-loop
    await processInNonBlockingBatches(due, 20, async (chunk) => {
      const outcomes = await Promise.all(chunk.map(({ employee, event }) => deliver({
        employee, event, date, company, orgName, now,
      }).catch((err) => {
        logger.error('[attendance-reminders] %s for %s failed: %s', event, employee._id, err.message);
        return 'failed';
      })));
      for (const outcome of outcomes) summary[outcome] += 1;
    });
  }

  if (summary.sent || summary.failed) {
    logger.info('[attendance-reminders] %s %s: %d sent, %d failed, %d already sent, %d no longer due.',
      date, time, summary.sent, summary.failed, summary.duplicate, summary.skipped);
  }
  return summary;
}
