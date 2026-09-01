import cron from 'node-cron';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import { isHoliday } from './holidays.js';
import { todayISO, isoDateDaysAgo } from './dateUtils.js';
import { notifyAttendanceEvent } from './attendanceNotify.js';
import logger from './logger.js';

import { connectDB } from '../db.js';

// Creates today's Attendance row for every employee who doesn't already have
// one — the root fix for there being no daily attendance history at all
// (previously a row was only ever created once, at seed/hire time).
export async function createTodaysAttendanceRows() {
  try {
    await connectDB();
    logger.info('[Attendance Daily Job] Creating today\'s attendance rows...');
    const date = todayISO();
    const employees = await Employee.find({});
    const holidaysByCompany = new Map();
    let createdCount = 0;

    for (const emp of employees) {
      const company = emp.company || 'Smaatech';
      // eslint-disable-next-line no-await-in-loop
      const exists = await Attendance.findOne({ empId: emp._id, date });
      if (exists) continue;

      if (!holidaysByCompany.has(company)) {
        // eslint-disable-next-line no-await-in-loop
        holidaysByCompany.set(company, await Holiday.find({ company }));
      }
      const holidays = holidaysByCompany.get(company);
      const status = emp.status === 'on-leave'
        ? 'leave'
        : (isHoliday(date, holidays) ? 'holiday' : 'absent');

      try {
        // eslint-disable-next-line no-await-in-loop
        await Attendance.create({
          empId: emp._id, name: emp.name, dept: emp.dept, date, status, company,
        });
        createdCount += 1;
      } catch (err) {
        // Unique (empId, date) index — a concurrent run already created this
        // row between the findOne check above and this create(). Safe to skip.
        if (err.code !== 11000) logger.error('[Attendance Daily Job Error] %o', err);
      }
    }
    logger.info(`[Attendance Daily Job] Finished. Created ${createdCount} attendance row(s) for ${date}.`);
  } catch (err) {
    logger.error('[Attendance Daily Job Error] %o', err);
  }
}

// By the time this runs (midnight), yesterday's attendance is final — no
// more chances for those employees to check in for that date. Notifies the
// employee and their manager for every row that's still 'absent' with no
// check-in at all (skips 'leave'/'holiday'/anything with a real check-in).
export async function notifyYesterdaysAbsences() {
  try {
    await connectDB();
    const yesterday = isoDateDaysAgo(1);
    const rows = await Attendance.find({ date: yesterday, status: 'absent', checkIn: null });
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await notifyAttendanceEvent({
        empId: row.empId,
        title: 'Unexplained Absence',
        message: `${row.name} did not check in on ${yesterday}.`,
        company: row.company,
      });
    }
    logger.info(`[Attendance Daily Job] Notified ${rows.length} absence(s) for ${yesterday}.`);
  } catch (err) {
    logger.error('[Attendance Daily Job Error] %o', err);
  }
}

async function runDailyJob() {
  await createTodaysAttendanceRows();
  await notifyYesterdaysAbsences();
}

export function startAttendanceDailyScheduler() {
  // Run on startup (5 second delay to let DB connect and server boot completely)
  setTimeout(() => {
    runDailyJob().catch((err) => logger.error('[Attendance Daily Job Startup Error] %o', err));
  }, 5000);

  // Run daily at midnight using node-cron (same schedule/style as the
  // document-expiry job — see lib/documentExpiryJob.js).
  cron.schedule('0 0 * * *', () => {
    runDailyJob().catch((err) => logger.error('[Attendance Daily Job Cron Error] %o', err));
  });
}
