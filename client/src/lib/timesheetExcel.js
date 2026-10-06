import ExcelJS from 'exceljs';
import { TIMESHEET_COLUMNS, timesheetFilename } from './timesheet';

// exceljs is used only for this report: the community `xlsx` build the other
// exports use cannot write fills, fonts, borders or row heights.
const NAVY = 'FF172B4D';
const HEADER_BLUE = 'FF1F3A6E';
const ZEBRA = 'FFF4F7FC';
const TOTAL_FILL = 'FFDDE6F4';
const BORDER = 'FFB0BCD0';
const WHITE = 'FFFFFFFF';

// Column widths in the locked column order, proportional to the PDF's.
const WIDTHS = [7, 30, 15, 10, 10, 15, 12, 11, 11, 15, 14];
const HEADER_ROW = 5;
// Durations are real Excel times so HR can sum or filter them; a zero prints
// as "0", exactly as the PDF shows it.
const DURATION_FORMAT = '[h]:mm;-[h]:mm;"0"';
const DURATION_KEYS = { regular: 'regularMinutes', overtime: 'overtimeMinutes', total: 'totalMinutes' };

const thin = { style: 'thin', color: { argb: BORDER } };
const grid = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const asDuration = (minutes) => (Number(minutes) || 0) / 1440;

/** Builds the styled workbook and returns it (ExcelJS.Workbook). */
export function buildTimesheetWorkbook(sheet) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Smaatech HRMS';
  const ws = workbook.addWorksheet('Timesheet', {
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.25 },
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`, // the column header repeats on every printed page
    },
    headerFooter: { oddFooter: '&L&8MONTHLY EMPLOYEE TIMESHEET&R&8Page &P of &N' },
    views: [{ state: 'frozen', ySplit: HEADER_ROW, showGridLines: false }],
  });
  const last = TIMESHEET_COLUMNS.length;
  ws.columns = WIDTHS.map((width) => ({ width }));

  // Title banner.
  ws.mergeCells(1, 1, 1, last);
  const title = ws.getCell(1, 1);
  title.value = sheet.title;
  title.font = { name: 'Calibri', size: 18, bold: true, color: { argb: WHITE } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  title.fill = fill(NAVY);
  ws.getRow(1).height = 34;
  ws.getRow(2).height = 6;

  // Employee and month.
  ws.mergeCells(3, 1, 3, 6);
  ws.mergeCells(3, 7, 3, last);
  const who = ws.getCell(3, 1);
  who.value = { richText: [
    { text: 'Employee Name: ', font: { name: 'Calibri', size: 12, bold: true, color: { argb: NAVY } } },
    { text: String(sheet.employeeLabel), font: { name: 'Calibri', size: 12, color: { argb: NAVY } } },
  ] };
  who.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  const when = ws.getCell(3, 7);
  when.value = { richText: [
    { text: 'Month: ', font: { name: 'Calibri', size: 12, bold: true, color: { argb: NAVY } } },
    { text: sheet.monthLabel, font: { name: 'Calibri', size: 12, color: { argb: NAVY } } },
  ] };
  when.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
  ws.getRow(3).height = 22;
  ws.getRow(4).height = 6;

  // Column header.
  const header = ws.getRow(HEADER_ROW);
  TIMESHEET_COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.label;
    cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: WHITE } };
    cell.fill = fill(HEADER_BLUE);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = grid;
  });
  header.height = 30;

  // One row per employee-day.
  sheet.rows.forEach((row, i) => {
    const r = ws.getRow(HEADER_ROW + 1 + i);
    TIMESHEET_COLUMNS.forEach((column, index) => {
      const cell = r.getCell(index + 1);
      if (DURATION_KEYS[column.key]) {
        cell.value = asDuration(row[DURATION_KEYS[column.key]]);
        cell.numFmt = DURATION_FORMAT;
      } else {
        cell.value = column.key === 'sno' ? row.sno : String(row[column.key]);
      }
      cell.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF212529' } };
      cell.alignment = { horizontal: column.key === 'name' ? 'left' : 'center', vertical: 'middle', indent: column.key === 'name' ? 1 : 0 };
      cell.border = grid;
      if (i % 2 === 1) cell.fill = fill(ZEBRA);
    });
    r.height = 18;
  });

  // TOTAL: sums of the durations, counts of the leave and holiday days.
  const totalRowNumber = HEADER_ROW + 1 + sheet.rows.length;
  const total = ws.getRow(totalRowNumber);
  const totalValues = {
    name: 'TOTAL',
    regular: asDuration(sheet.totals.regular),
    overtime: asDuration(sheet.totals.overtime),
    onLeave: sheet.totals.leaveDays,
    holiday: sheet.totals.holidayDays,
    total: asDuration(sheet.totals.total),
  };
  const strong = { style: 'medium', color: { argb: NAVY } };
  TIMESHEET_COLUMNS.forEach((column, index) => {
    const cell = total.getCell(index + 1);
    cell.value = totalValues[column.key] ?? '';
    if (DURATION_KEYS[column.key]) cell.numFmt = DURATION_FORMAT;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: NAVY } };
    cell.fill = fill(TOTAL_FILL);
    cell.alignment = { horizontal: column.key === 'name' ? 'left' : 'center', vertical: 'middle', indent: column.key === 'name' ? 1 : 0 };
    cell.border = { top: strong, bottom: strong, left: thin, right: thin };
  });
  total.height = 22;

  ws.pageSetup.printArea = `A1:${String.fromCharCode(64 + last)}${totalRowNumber}`;
  return workbook;
}

export async function downloadTimesheetExcel(sheet) {
  const buffer = await buildTimesheetWorkbook(sheet).xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${timesheetFilename(sheet)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
