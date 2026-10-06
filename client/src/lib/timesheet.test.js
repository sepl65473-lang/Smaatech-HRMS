// Monthly Employee Timesheet: the data, and that the PDF and the Excel file
// both carry exactly that data. Names and times below are test fixtures.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildMonthlyTimesheet, monthBounds, formatHours, shiftMinutes, timesheetBody, timesheetTotalRow, timesheetFilename, TIMESHEET_COLUMNS,
} from './timesheet';
import { buildTimesheetPdf } from './timesheetPdf';
import { buildTimesheetWorkbook } from './timesheetExcel';

const A = { id: 'emp-a', name: 'Asha Rao' };
const B = { id: 'emp-b', name: 'Bikram Das' };
const att = (emp, date, checkIn, checkOut, workedMinutes, status) => ({ empId: emp.id, name: emp.name, date, checkIn, checkOut, workedMinutes, status });
const HOLIDAYS = [{ name: 'Founders Day', date: '15 May, Fri' }, { name: 'New Year', date: '1 Jan, Thu' }];
const LEAVES = [
  { empId: 'emp-a', start: '2026-05-11', end: '2026-05-12', status: 'approved' },
  { empId: 'emp-a', start: '2026-05-20', end: '2026-05-20', status: 'pending' },
];
const MAY = [
  att(A, '2026-05-04', '09:00', '17:30', 510, 'present'), // 8:30
  att(A, '2026-05-05', '09:00', '18:00', 540, 'present'), // 9:00
  att(A, '2026-05-06', '09:00', '19:00', 600, 'present'), // 10:00
  att(A, '2026-05-07', '09:30', '21:00', 690, 'late'), // 11:30
  att(A, '2026-05-08', '09:10', null, null, 'present'), // one punch only
  att(A, '2026-05-11', null, null, null, 'leave'),
  att(A, '2026-05-13', null, null, null, 'absent'),
  att(A, '2026-05-15', null, null, null, 'holiday'),
  att(B, '2026-05-04', '10:00', '18:15', 495, 'late'),
  att(A, '2026-04-30', '09:00', '18:00', 540, 'present'), // another month: must not appear
  att(A, '2026-06-01', '09:00', '18:00', 540, 'present'),
];
const build = (over = {}) => buildMonthlyTimesheet({
  year: 2026, month: 5, employees: [A], employeeLabel: A.name, attendance: MAY, leaves: LEAVES, holidays: HOLIDAYS, today: '2026-05-25', ...over,
});
const day = (sheet, iso, empId = 'emp-a') => sheet.rows.find((r) => r.iso === iso && r.empId === empId);

describe('monthly timesheet — data', () => {
  it('1. one employee, one month: every calendar day once, in the locked column order', () => {
    const sheet = build();
    expect(TIMESHEET_COLUMNS.map((c) => c.label)).toEqual(['S.No.', 'EMPLOYEE NAME', 'DATE', 'LOG IN', 'LOG OUT', 'REGULAR HOURS', 'OVERTIME', 'ON LEAVE', 'HOLIDAY', 'STATUS', 'TOTAL HOURS']);
    expect(sheet).toMatchObject({ title: 'MONTHLY EMPLOYEE TIMESHEET', employeeLabel: 'Asha Rao', monthLabel: 'May 2026', from: '2026-05-01', to: '2026-05-31' });
    expect(sheet.rows).toHaveLength(31);
    expect(sheet.rows.map((r) => r.sno)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(sheet.rows.every((r) => r.iso >= '2026-05-01' && r.iso <= '2026-05-31' && r.name === 'Asha Rao')).toBe(true);
    expect(day(sheet, '2026-05-04')).toMatchObject({ date: '04 May 2026', logIn: '09:00', logOut: '17:30', status: 'Present' });
  });

  it('2. a different employee, same month, gets only their own records', () => {
    const sheet = build({ employees: [B], employeeLabel: B.name });
    expect(sheet.employeeLabel).toBe('Bikram Das');
    expect(day(sheet, '2026-05-04', 'emp-b')).toMatchObject({ logIn: '10:00', logOut: '18:15', total: '8:15', status: 'Late' });
    expect(sheet.rows.filter((r) => r.logIn !== '—')).toHaveLength(1);
    expect(sheet.totals.totalText).toBe('8:15');
  });

  it('3. all employees: header says All Employees, names stay in the table, ordered by name', () => {
    const sheet = build({ employees: [B, A], employeeLabel: 'All Employees' });
    expect(sheet.employeeLabel).toBe('All Employees');
    expect(sheet.rows).toHaveLength(62);
    expect(sheet.rows[0].name).toBe('Asha Rao');
    expect(sheet.rows[31].name).toBe('Bikram Das');
    expect(sheet.rows[61].sno).toBe(62);
    expect(sheet.totals.total).toBe(510 + 540 + 600 + 690 + 495);
  });

  it('4-5. a different month and year: exact calendar bounds, leap years, no data from elsewhere', () => {
    expect(monthBounds(2026, 2)).toMatchObject({ from: '2026-02-01', to: '2026-02-28', days: 28 });
    expect(monthBounds(2028, 2)).toMatchObject({ to: '2028-02-29', days: 29 });
    expect(monthBounds(2025, 12)).toMatchObject({ from: '2025-12-01', to: '2025-12-31', days: 31 });
    const april = build({ month: 4 });
    expect(april.monthLabel).toBe('April 2026');
    expect(april.rows).toHaveLength(30);
    expect(april.rows.filter((r) => r.logIn !== '—').map((r) => r.iso)).toEqual(['2026-04-30']);
    const otherYear = build({ year: 2025 });
    expect(otherYear.monthLabel).toBe('May 2025');
    expect(otherYear.totals.total).toBe(0);
    expect(otherYear.rows.every((r) => r.logIn === '—')).toBe(true);
  });

  it('6. overtime: regular is capped at 9:00, the rest is overtime, and the two always add up to the server total', () => {
    const sheet = build();
    expect(day(sheet, '2026-05-04')).toMatchObject({ regular: '8:30', overtime: '0', total: '8:30' });
    expect(day(sheet, '2026-05-05')).toMatchObject({ regular: '9:00', overtime: '0', total: '9:00' });
    expect(day(sheet, '2026-05-06')).toMatchObject({ regular: '9:00', overtime: '1:00', total: '10:00' });
    expect(day(sheet, '2026-05-07')).toMatchObject({ regular: '9:00', overtime: '2:30', total: '11:30' });
    for (const row of sheet.rows) {
      const source = MAY.find((r) => r.empId === row.empId && r.date === row.iso);
      expect(row.totalMinutes).toBe(source?.workedMinutes ?? 0); // the server's figure, untouched
      expect(row.regularMinutes + row.overtimeMinutes).toBe(row.totalMinutes);
    }
    expect(formatHours(0)).toBe('0');
    expect(formatHours(65)).toBe('1:05');
  });

  it('the regular day is the length of the configured shift of each employee', () => {
    expect(shiftMinutes({ start: '09:00', end: '18:00' })).toBe(540); // General
    expect(shiftMinutes({ start: '06:00', end: '14:00' })).toBe(480); // Morning
    expect(shiftMinutes({ start: '22:00', end: '06:00' })).toBe(480); // Night, past midnight
    expect(shiftMinutes({ start: '09:30', end: '18:00' })).toBe(510);
    expect(shiftMinutes(null)).toBe(540);
    const eightHour = build({ regularMinutesFor: () => 480 });
    expect(day(eightHour, '2026-05-06')).toMatchObject({ regular: '8:00', overtime: '2:00', total: '10:00' });
    expect(day(eightHour, '2026-05-04')).toMatchObject({ regular: '8:00', overtime: '0:30', total: '8:30' });
    expect(eightHour.rows.every((r) => r.regularMinutes + r.overtimeMinutes === r.totalMinutes)).toBe(true);
  });

  it('7. leave: Yes only for recorded or approved leave; the total is a count of days', () => {
    const sheet = build();
    expect(day(sheet, '2026-05-11')).toMatchObject({ onLeave: 'Yes', status: 'On leave', logIn: '—', total: '0' }); // attendance row says leave
    expect(day(sheet, '2026-05-12')).toMatchObject({ onLeave: 'Yes', status: 'On leave' }); // approved leave, no attendance row
    expect(day(sheet, '2026-05-20')).toMatchObject({ onLeave: 'No' }); // pending leave is not leave
    expect(sheet.totals.leaveDays).toBe(2);
    expect(timesheetTotalRow(sheet)[7]).toBe('2');
  });

  it('8. holidays come from the holiday list; the total is a count of days', () => {
    const sheet = build();
    expect(day(sheet, '2026-05-15')).toMatchObject({ holiday: 'Yes', status: 'Holiday' });
    expect(sheet.rows.filter((r) => r.holiday === 'Yes').map((r) => r.iso)).toEqual(['2026-05-15']);
    expect(sheet.totals.holidayDays).toBe(1);
    expect(build({ month: 1, employees: [A] }).totals.holidayDays).toBe(1); // 1 Jan
    expect(build({ holidays: [] }).rows.filter((r) => r.holiday === 'Yes').map((r) => r.iso)).toEqual(['2026-05-15']); // the attendance row itself says holiday
  });

  it('9. a day with no punch: dashes and zeros, and no status is invented', () => {
    const sheet = build();
    expect(day(sheet, '2026-05-13')).toMatchObject({ logIn: '—', logOut: '—', regular: '0', overtime: '0', total: '0', status: 'Absent' }); // recorded absent
    expect(day(sheet, '2026-05-14')).toMatchObject({ logIn: '—', logOut: '—', total: '0', onLeave: 'No', holiday: 'No', status: 'No record' }); // nothing recorded
    expect(day(sheet, '2026-05-28')).toMatchObject({ logIn: '—', total: '0', status: '—' }); // after "today"
    expect(day(sheet, '2026-05-08')).toMatchObject({ logIn: '09:10', logOut: '—', regular: '0', overtime: '0', total: '0', status: 'Present' }); // one punch only
  });

  it('the TOTAL row sums hours and counts days, and leaves text columns blank', () => {
    const sheet = build();
    expect(sheet.totals).toMatchObject({ regular: 510 + 540 + 540 + 540, overtime: 60 + 150, total: 510 + 540 + 600 + 690, leaveDays: 2, holidayDays: 1 });
    expect(timesheetTotalRow(sheet)).toEqual(['', 'TOTAL', '', '', '', '35:30', '3:30', '2', '1', '', '39:00']);
    expect(timesheetFilename(sheet)).toBe('monthly-timesheet-Asha-Rao-2026-05');
  });
});

describe('monthly timesheet — PDF and Excel carry the same data', () => {
  const readWorkbook = async (sheet) => {
    const buffer = await buildTimesheetWorkbook(sheet).xlsx.writeBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb.getWorksheet('Timesheet');
  };
  const cellText = (cell) => {
    if (cell.numFmt && cell.numFmt.includes('[h]')) {
      // exceljs reads a duration-formatted number back as a date counted from Excel's day zero.
      const days = cell.value instanceof Date ? (cell.value.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : Number(cell.value);
      return formatHours(Math.round(days * 1440));
    }
    if (cell.value && typeof cell.value === 'object' && cell.value.richText) return cell.value.richText.map((t) => t.text).join('');
    return cell.value == null ? '' : String(cell.value);
  };

  it('Excel: title, header, every row and the TOTAL row equal the report data, with print setup and styling', async () => {
    const sheet = build({ employees: [B, A], employeeLabel: 'All Employees' });
    const ws = await readWorkbook(sheet);
    expect(cellText(ws.getCell('A1'))).toBe('MONTHLY EMPLOYEE TIMESHEET');
    expect(cellText(ws.getCell('A3'))).toBe('Employee Name: All Employees');
    expect(cellText(ws.getCell('G3'))).toBe('Month: May 2026');
    expect(TIMESHEET_COLUMNS.map((_, i) => cellText(ws.getRow(5).getCell(i + 1)))).toEqual(TIMESHEET_COLUMNS.map((c) => c.label));
    const body = timesheetBody(sheet);
    body.forEach((expected, i) => {
      expect(TIMESHEET_COLUMNS.map((_, c) => cellText(ws.getRow(6 + i).getCell(c + 1)))).toEqual(expected);
    });
    const totalRow = ws.getRow(6 + body.length);
    expect(TIMESHEET_COLUMNS.map((_, c) => cellText(totalRow.getCell(c + 1)))).toEqual(timesheetTotalRow(sheet));
    expect(ws.getRow(7 + body.length).getCell(1).value).toBeNull(); // nothing after TOTAL

    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '5:5' });
    expect(ws.pageSetup.printArea).toBe(`A1:K${6 + body.length}`);
    expect(ws.getCell('A1').fill.fgColor.argb).toBe('FF172B4D');
    expect(ws.getCell('A1').font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } });
    expect(ws.getRow(5).getCell(3).fill.fgColor.argb).toBe('FF1F3A6E');
    expect(ws.getRow(6).getCell(2).border.top.style).toBe('thin');
    expect(totalRow.getCell(6).font.bold).toBe(true);
    expect(totalRow.getCell(6).fill.fgColor.argb).toBe('FFDDE6F4');
    expect(ws.getColumn(2).width).toBe(30);
    expect(ws.getRow(6).height).toBe(18);
  });

  it('PDF: landscape, the same body and TOTAL row, header repeated on every page, TOTAL only at the end', () => {
    const sheet = build({ employees: [B, A], employeeLabel: 'All Employees' });
    const doc = buildTimesheetPdf(sheet);
    const { width, height } = doc.internal.pageSize;
    expect(width).toBeGreaterThan(height);
    const table = doc.lastAutoTable;
    expect(table.head[0].cells && Object.values(table.head[0].cells).map((c) => c.text.join(' '))).toEqual(TIMESHEET_COLUMNS.map((c) => c.label));
    expect(table.body.map((row) => Object.values(row.cells).map((c) => c.text.join(' ')))).toEqual(timesheetBody(sheet));
    expect(Object.values(table.foot[0].cells).map((c) => c.text.join(' '))).toEqual(timesheetTotalRow(sheet));
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(table.settings.showHead).toBe('everyPage');
    expect(table.settings.showFoot).toBe('lastPage');
  });

  it('10. a large report: no row lost, duplicated or cut, in either file', async () => {
    const people = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, name: `Employee ${String(i + 1).padStart(3, '0')} With A Fairly Long Name` }));
    const attendance = people.flatMap((p, i) => Array.from({ length: 31 }, (_, d) => att(p, `2026-05-${String(d + 1).padStart(2, '0')}`, '09:00', '18:30', 540 + ((i + d) % 4) * 30, 'present')));
    const sheet = buildMonthlyTimesheet({ year: 2026, month: 5, employees: people, employeeLabel: 'All Employees', attendance, leaves: [], holidays: [], today: '2026-06-30' });
    expect(sheet.rows).toHaveLength(120 * 31);
    expect(new Set(sheet.rows.map((r) => `${r.empId}|${r.iso}`)).size).toBe(120 * 31);
    expect(sheet.totals.total).toBe(attendance.reduce((sum, r) => sum + r.workedMinutes, 0));
    expect(sheet.totals.regular + sheet.totals.overtime).toBe(sheet.totals.total);

    const doc = buildTimesheetPdf(sheet);
    const table = doc.lastAutoTable;
    expect(table.body).toHaveLength(120 * 31);
    expect(doc.getNumberOfPages()).toBeGreaterThan(50);
    expect(Object.values(table.foot[0].cells).map((c) => c.text.join(' '))).toEqual(timesheetTotalRow(sheet));
    // No name was shortened to fit: the full text is in the cell.
    expect(Object.values(table.body[0].cells)[1].text.join(' ')).toBe('Employee 001 With A Fairly Long Name');

    const ws = await readWorkbook(sheet);
    expect(ws.getRow(6 + 120 * 31 - 1).getCell(1).value).toBe(120 * 31);
    expect(cellText(ws.getRow(6 + 120 * 31).getCell(2))).toBe('TOTAL');
    expect(cellText(ws.getRow(6 + 120 * 31).getCell(11))).toBe(sheet.totals.totalText);
  }, 120000);
});
