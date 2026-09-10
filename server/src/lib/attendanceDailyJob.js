import cron from 'node-cron';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Holiday from '../models/Holiday.js';
import { isHoliday } from './holidays.js';
import { todayISO, isoDateDaysAgo } from './dateUtils.js';
import { notifyAttendanceEvent } from './attendanceNotify.js';
import { processInNonBlockingBatches } from './jobQueue.js';
import logger from './logger.js';

import { connectDB } from '../db.js';

// Creates today's Attendance row for every employee in non-blocking chunked batches
export async function createTodaysAttendanceRows() {
  try {
    await connectDB();
    logger.info('[Attendance Daily Job] Creating today\'s attendance rows...');
    const date = todayISO();
    const employees = await Employee.find({});
    if (!employees.length) return;

    // Single query to find all existing attendance records for today
    const empIds = employees.map((e) => e._id);
    const existingRows = await Attendance.find({ date, empId: { $in: empIds } }, { empId: 1 }).lean();
    const existingSet = new Set(existingRows.map((r) => String(r.empId)));

    const pendingEmployees = employees.filter((emp) => !existingSet.has(String(emp._id)));
    if (!pendingEmployees.length) {
      logger.info(`[Attendance Daily Job] Finished. All ${employees.length} attendance rows already exist for ${date}.`);
      return;
    }

    // Batch load holidays for involved companies
    const companies = [...new Set(pendingEmployees.map((e) => e.company || 'Smaatech'))];
    const holidays = await Holiday.find({ company: { $in: companies } }).lean();
    const holidaysByCompany = new Map();
    for (const h of holidays) {
      const c = h.company || 'Smaatech';
      if (!holidaysByCompany.has(c)) holidaysByCompany.set(c, []);
      holidaysByCompany.get(c).push(h);
    }

    // Prepare bulkWrite insert operations
    const bulkOps = pendingEmployees.map((emp) => {
      const company = emp.company || 'Smaatech';
      const companyHolidays = holidaysByCompany.get(company) || [];
      const status = emp.status === 'on-leave'
        ? 'leave'
        : (isHoliday(date, companyHolidays) ? 'holiday' : 'absent');

      return {
        insertOne: {
          document: {
            empId: emp._id,
            name: emp.name,
            dept: emp.dept,
            date,
            status,
            company,
          },
        },
      };
    });

    // Execute bulkWrite in non-blocking 250-item batches with event loop pauses
    let totalCreated = 0;
    await processInNonBlockingBatches(bulkOps, 250, async (chunk) => {
      const res = await Attendance.bulkWrite(chunk, { ordered: false });
      totalCreated += res.insertedCount || chunk.length;
    });

    logger.info(`[Attendance Daily Job] Finished. Non-blocking bulk created ${totalCreated} attendance row(s) for ${date}.`);
  } catch (err) {
    if (err.code !== 11000) {
      logger.error('[Attendance Daily Job Error] %o', err);
    }
  }
}

// Notifies yesterday's absences in non-blocking chunked batches
export async function notifyYesterdaysAbsences() {
  try {
    await connectDB();
    const yesterday = isoDateDaysAgo(1);
    const rows = await Attendance.find({ date: yesterday, status: 'absent', checkIn: null });
    if (!rows.length) return;

    await processInNonBlockingBatches(rows, 50, async (chunk) => {
      await Promise.all(chunk.map((row) => notifyAttendanceEvent({
        empId: row.empId,
        title: 'Unexplained Absence',
        message: `${row.name} did not check in on ${yesterday}.`,
        company: row.company,
      })));
    });

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
