import { MONTH_NAMES, parseHolidayDay } from './helpers';
import { ATTENDANCE_STATUS } from './attendanceStatus';

/**
 * Monthly Employee Timesheet — the report's data, built once and rendered by
 * both the PDF and the Excel writer so the two cannot disagree.
 *
 * This is a presentation layer over data the HRMS already holds. It reads:
 *   - attendance rows as the server returns them (check-in, check-out, status
 *     and the server-derived workedMinutes);
 *   - approved leave records;
 *   - the company holiday list.
 * It decides nothing about attendance. The only arithmetic of its own is the
 * report's split of the server's workedMinutes into regular time (up to the
 * length of the employee's shift) and overtime (anything beyond), and the
 * totals.
 */
// The regular day is the employee's own shift as the HRMS configures it
// (Settings shifts; General is 09:00-18:00, nine hours). This is used only
// when a shift has no readable start and end.
export const REGULAR_MINUTES_PER_DAY = 9 * 60;

/** Length of a shift in minutes, from its configured start and end ("HH:MM"). */
export function shiftMinutes(shift) {
  const parse = (value) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = parse(shift?.start);
  const end = parse(shift?.end);
  if (start == null || end == null || start === end) return REGULAR_MINUTES_PER_DAY;
  return end > start ? end - start : (24 * 60 - start) + end; // a night shift ends the next day
}

export const TIMESHEET_COLUMNS = [
  { key: 'sno', label: 'S.No.' },
  { key: 'name', label: 'EMPLOYEE NAME' },
  { key: 'date', label: 'DATE' },
  { key: 'logIn', label: 'LOG IN' },
  { key: 'logOut', label: 'LOG OUT' },
  { key: 'regular', label: 'REGULAR HOURS' },
  { key: 'overtime', label: 'OVERTIME' },
  { key: 'onLeave', label: 'ON LEAVE' },
  { key: 'holiday', label: 'HOLIDAY' },
  { key: 'status', label: 'STATUS' },
  { key: 'total', label: 'TOTAL HOURS' },
];

export const FULL_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n) => String(n).padStart(2, '0');

/** First and last calendar day of a month, as YYYY-MM-DD. `month` is 1-12. */
export function monthBounds(year, month) {
  const days = new Date(year, month, 0).getDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(days)}`, days };
}

/** "8:30" for 510 minutes; "0" when there is no time, as the report shows it. */
export function formatHours(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total === 0) return '0';
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

const NO_PUNCH = '—';

/**
 * @param {object} input
 * @param {number} input.year
 * @param {number} input.month 1-12
 * @param {Array<{id:string,name:string}>} input.employees the people to report on
 * @param {string} input.employeeLabel header text: a name, or "All Employees"
 * @param {Array} input.attendance attendance rows for the month, as the API returns them
 * @param {Array} input.leaves leave records
 * @param {Array} input.holidays company holiday list
 * @param {string} input.today YYYY-MM-DD; days after it have not happened yet
 * @param {(empId: string) => number} [input.regularMinutesFor] the employee's shift length in minutes
 */
export function buildMonthlyTimesheet({ year, month, employees, employeeLabel, attendance = [], leaves = [], holidays = [], today, regularMinutesFor }) {
  const { from, to, days } = monthBounds(year, month);

  const holidayDays = new Set();
  for (const h of holidays) {
    const parsed = parseHolidayDay(h?.date);
    if (parsed && parsed.month === month - 1) holidayDays.add(parsed.day);
  }

  const byEmployeeDay = new Map();
  for (const row of attendance) {
    if (!row?.date || row.date < from || row.date > to) continue; // never another month
    byEmployeeDay.set(`${row.empId}|${row.date}`, row);
  }

  const approvedLeaves = leaves.filter((l) => l?.status === 'approved');
  const onApprovedLeave = (empId, date) => approvedLeaves.some((l) => String(l.empId) === String(empId)
    && String(l.start) <= date && String(l.end) >= date);

  const people = [...employees].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const rows = [];
  const totals = { regular: 0, overtime: 0, total: 0, leaveDays: 0, holidayDays: 0 };

  for (const person of people) {
    const configured = Number(regularMinutesFor?.(person.id));
    const regularCap = Number.isFinite(configured) && configured > 0 ? configured : REGULAR_MINUTES_PER_DAY;
    for (let day = 1; day <= days; day += 1) {
      const iso = `${year}-${pad(month)}-${pad(day)}`;
      const record = byEmployeeDay.get(`${person.id}|${iso}`) || null;

      // The server's own figure. A day with one punch, or none, has no total.
      const worked = record && record.workedMinutes != null && Number.isFinite(Number(record.workedMinutes))
        ? Math.max(0, Number(record.workedMinutes)) : 0;
      const regular = Math.min(worked, regularCap);
      const overtime = Math.max(0, worked - regularCap);

      const onLeave = record ? record.status === 'leave' : onApprovedLeave(person.id, iso);
      const holiday = holidayDays.has(day) || record?.status === 'holiday';

      // Status is the attendance record's own status, labelled as everywhere
      // else in the HRMS. The server's daily job writes a record for every
      // employee on every day (absent, leave or holiday until a punch changes
      // it), so a past day with no record at all is one the HRMS holds no
      // status for - typically before the employee was added. Nothing is made
      // up for it: it is described only by what the leave and holiday data
      // actually say, and otherwise reads "No record".
      let status;
      if (record) status = ATTENDANCE_STATUS[record.status]?.label || record.status || NO_PUNCH;
      else if (onLeave) status = ATTENDANCE_STATUS.leave.label;
      else if (holiday) status = ATTENDANCE_STATUS.holiday.label;
      else if (today && iso > today) status = NO_PUNCH; // not happened yet
      else status = 'No record';

      rows.push({
        sno: rows.length + 1,
        empId: person.id,
        name: person.name,
        iso,
        date: `${pad(day)} ${MONTH_NAMES[month - 1]} ${year}`,
        logIn: record?.checkIn || NO_PUNCH,
        logOut: record?.checkOut || NO_PUNCH,
        regularMinutes: regular,
        overtimeMinutes: overtime,
        totalMinutes: worked,
        regular: formatHours(regular),
        overtime: formatHours(overtime),
        total: formatHours(worked),
        onLeave: onLeave ? 'Yes' : 'No',
        holiday: holiday ? 'Yes' : 'No',
        status,
      });

      totals.regular += regular;
      totals.overtime += overtime;
      totals.total += worked;
      if (onLeave) totals.leaveDays += 1;
      if (holiday) totals.holidayDays += 1;
    }
  }

  return {
    title: 'MONTHLY EMPLOYEE TIMESHEET',
    employeeLabel,
    monthLabel: `${FULL_MONTH_NAMES[month - 1]} ${year}`,
    year,
    month,
    from,
    to,
    rows,
    totals: {
      ...totals,
      regularText: formatHours(totals.regular),
      overtimeText: formatHours(totals.overtime),
      totalText: formatHours(totals.total),
    },
  };
}

/** The table body, in the locked column order, exactly as both files print it. */
export function timesheetBody(sheet) {
  return sheet.rows.map((row) => TIMESHEET_COLUMNS.map((c) => String(row[c.key])));
}

/** The TOTAL row. Text columns are left blank; leave and holiday are day counts. */
export function timesheetTotalRow(sheet) {
  return ['', 'TOTAL', '', '', '', sheet.totals.regularText, sheet.totals.overtimeText,
    String(sheet.totals.leaveDays), String(sheet.totals.holidayDays), '', sheet.totals.totalText];
}

export function timesheetFilename(sheet) {
  const who = String(sheet.employeeLabel || 'employee').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
  return `monthly-timesheet-${who}-${sheet.year}-${pad(sheet.month)}`;
}
