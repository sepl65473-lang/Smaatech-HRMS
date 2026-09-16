import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import LeaveType from '../models/LeaveType.js';
import Settings from '../models/Settings.js';
import { scheduleJob, isSchedulerOwner, registeredJobs } from './scheduler.js';
import { retryPendingDeliveries } from './notificationService.js';
import { runScheduledBackup, isScheduledBackupConfigured, backupDestination } from './backupJob.js';
import { createTodaysAttendanceRows, notifyYesterdaysAbsences } from './attendanceDailyJob.js';
import { checkDocumentExpirations } from './documentExpiryJob.js';
import { accrueMonthly, rollOverYear, leaveYearOf, ensureLeaveTypes } from './leaveLedger.js';
import { notifyAttendanceEvent } from './attendanceNotify.js';
import { processInNonBlockingBatches } from './jobQueue.js';
import { todayISO, isoDateDaysAgo } from './dateUtils.js';
import { connectDB } from '../db.js';
import logger from './logger.js';

/**
 * Closes out a day where somebody checked in and never checked out.
 *
 * Without this, such a row keeps `checkOut: null` forever, sits at whatever
 * status the check-in produced ('present' or 'late'), and is counted as a full
 * paid day by payroll's LOP calculation. That is the single most common real
 * attendance data-quality problem, and nothing in the product handled it.
 *
 * The day is NOT silently auto-completed with a fabricated checkout time —
 * inventing an end time would be making up attendance data. It is flagged for
 * HR, and the employee is prompted to file a correction.
 */
export async function flagMissingCheckouts() {
  await connectDB();
  const yesterday = isoDateDaysAgo(1);

  const orphans = await Attendance.find({
    date: yesterday,
    checkIn: { $ne: null },
    checkOut: null,
    status: { $nin: ['leave', 'holiday'] },
  });
  if (!orphans.length) return { flagged: 0, date: yesterday };

  await processInNonBlockingBatches(orphans, 50, async (chunk) => {
    await Promise.all(chunk.map(async (row) => {
      await Attendance.updateOne(
        { _id: row._id },
        {
          $addToSet: { anomalyFlags: 'missing-checkout' },
          $set: { checkOutDetails: 'No check-out recorded — awaiting correction' },
        },
      );
      await notifyAttendanceEvent({
        empId: row.empId,
        title: 'Missing Check-out',
        message: `${row.name} checked in on ${yesterday} at ${row.checkIn} but never checked out. Submit an attendance correction to close the day.`,
        company: row.company,
      });
    }));
  });

  logger.info('[jobs] flagged %d attendance row(s) with a missing check-out for %s.', orphans.length, yesterday);
  return { flagged: orphans.length, date: yesterday };
}

/**
 * Monthly leave accrual for every employee on a monthly-accrual leave type.
 * Idempotent: lib/leaveLedger.js guards on lastAccruedMonth, so a re-run in
 * the same month credits nothing.
 */
export async function runMonthlyLeaveAccrual() {
  await connectDB();
  const today = todayISO();
  const month = Number(today.slice(5, 7));

  const companies = await Employee.distinct('company');
  let credited = 0;

  for (const company of companies) {
    // eslint-disable-next-line no-await-in-loop
    await ensureLeaveTypes(company);
    // eslint-disable-next-line no-await-in-loop
    const monthlyTypes = await LeaveType.find({ company, accrualMode: 'monthly', paid: true, active: true });
    if (!monthlyTypes.length) continue;

    // eslint-disable-next-line no-await-in-loop
    const settings = await Settings.findById(company);
    const year = leaveYearOf(today, settings?.leaveYearStartMonth || 1);

    // Only currently-employed people accrue.
    // eslint-disable-next-line no-await-in-loop
    const employees = await Employee.find({ company, status: { $nin: ['exited', 'terminated'] } }).select('_id').lean();

    // eslint-disable-next-line no-await-in-loop
    await processInNonBlockingBatches(employees, 100, async (chunk) => {
      for (const emp of chunk) {
        for (const type of monthlyTypes) {
          // eslint-disable-next-line no-await-in-loop
          const result = await accrueMonthly({ company, empId: emp._id, year, type: type.code, month });
          if (result.ok && !result.skipped) credited += 1;
        }
      }
    });
  }

  logger.info('[jobs] monthly leave accrual credited %d balance(s) for month %d.', credited, month);
  return { credited, month };
}

/**
 * Year-end roll: carry forward what the policy allows, lapse the rest, and
 * open next year's balances. Every movement is ledgered, so an employee can
 * see exactly how many days lapsed and why.
 */
export async function runLeaveYearRollover() {
  await connectDB();
  const today = todayISO();
  const companies = await Employee.distinct('company');
  let rolled = 0;

  for (const company of companies) {
    // eslint-disable-next-line no-await-in-loop
    const settings = await Settings.findById(company);
    const startMonth = settings?.leaveYearStartMonth || 1;
    const month = Number(today.slice(5, 7));
    // Only roll on the first day of this company's own leave year.
    if (month !== startMonth || Number(today.slice(8, 10)) !== 1) continue;

    const toYear = leaveYearOf(today, startMonth);
    const fromYear = toYear - 1;

    // eslint-disable-next-line no-await-in-loop
    const employees = await Employee.find({ company, status: { $nin: ['exited', 'terminated'] } }).select('_id').lean();
    // eslint-disable-next-line no-await-in-loop
    await processInNonBlockingBatches(employees, 50, async (chunk) => {
      for (const emp of chunk) {
        // eslint-disable-next-line no-await-in-loop
        await rollOverYear({ company, empId: emp._id, fromYear, toYear });
        rolled += 1;
      }
    });
  }

  logger.info('[jobs] leave year rollover processed %d employee(s).', rolled);
  return { rolled };
}

/**
 * Starts every scheduled job. Safe to call from any process: scheduleJob()
 * registers nothing unless this process is the scheduler owner, which is what
 * stops a clustered deployment running each job once per worker.
 */
export function startSchedulers() {
  if (!isSchedulerOwner()) {
    logger.info('[scheduler] this process is not the scheduler owner — no cron jobs started here.');
    return registeredJobs();
  }

  // Boot run, so a deployment part-way through a day still gets its rows.
  setTimeout(() => {
    createTodaysAttendanceRows().catch((err) => logger.error('[jobs] startup attendance rows failed: %o', err));
  }, 5000);

  scheduleJob('attendance:create-daily-rows', '5 0 * * *', createTodaysAttendanceRows);
  scheduleJob('attendance:notify-absences', '0 10 * * *', notifyYesterdaysAbsences);
  scheduleJob('attendance:flag-missing-checkouts', '30 1 * * *', flagMissingCheckouts);
  scheduleJob('documents:expiry-reminders', '0 9 * * *', checkDocumentExpirations);
  // Last day handling is unnecessary: the accrual is idempotent per month, so
  // running on the 1st credits the month that just began.
  scheduleJob('leave:monthly-accrual', '0 2 1 * *', runMonthlyLeaveAccrual);
  scheduleJob('leave:year-rollover', '30 2 1 * *', runLeaveYearRollover);

  // Email delivery used to be fire-and-forget: a bounce or an SMTP outage was
  // logged once and the notification was simply lost. Failed deliveries are now
  // recorded and retried on a backoff, so a provider blip does not mean nobody
  // ever hears about their payslip.
  scheduleJob('notifications:retry-failed', '*/5 * * * *', async () => {
    await retryPendingDeliveries({ limit: 100 });
  });

  // Nightly backup, verified and pruned to the retention window. Opt-in: with
  // no BACKUP_DIR it does not run, rather than writing to a directory that
  // disappears with the container.
  if (isScheduledBackupConfigured()) {
    scheduleJob('backup:nightly', process.env.BACKUP_CRON || '0 1 * * *', async () => {
      await runScheduledBackup();
    });
    logger.info('[backup] nightly backup scheduled to %s (retention %s days)',
      backupDestination(), process.env.BACKUP_RETENTION_DAYS || 14);
  } else {
    logger.warn('[backup] BACKUP_DIR is not set — no scheduled database backup is running.');
  }

  return registeredJobs();
}
