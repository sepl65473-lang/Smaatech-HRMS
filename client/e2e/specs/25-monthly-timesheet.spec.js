import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { login } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * MONTHLY EMPLOYEE TIMESHEET, driven through the real page: the Employee,
 * Month and Year selectors are operated and both files are downloaded and
 * read back. The whole stack is the isolated tenant from global-setup.
 */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

// Fourteen months back: a complete month, and outside the twelve months that
// 19-exports fills with its own rows for the same employee.
const target = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 14);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return { year, month, days: new Date(year, month, 0).getDate(), label: `${MONTH_NAMES[month - 1]} ${year}` };
})();
const iso = (day) => `${target.year}-${pad(target.month)}-${pad(day)}`;
const OUT = process.env.TIMESHEET_OUT || '';
const keep = (name, buffer) => { if (OUT) fs.writeFileSync(path.join(OUT, name), buffer); };

const text = (cell) => {
  const v = cell.value;
  if (cell.numFmt && cell.numFmt.includes('[h]')) {
    const days = v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : Number(v);
    const minutes = Math.round(days * 1440);
    return minutes === 0 ? '0' : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
  }
  if (v && typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('');
  return v == null ? '' : String(v);
};
const hours = (minutes) => (minutes ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}` : '0');

async function openTimesheet(page, { employee, month, year }) {
  await page.goto('/attendance');
  const employeeSelect = page.getByLabel('Timesheet employee');
  await employeeSelect.waitFor({ state: 'visible', timeout: 30_000 });
  await employeeSelect.selectOption(employee === 'all' ? 'all' : { label: employee });
  await page.getByLabel('Timesheet month').selectOption(String(month));
  await page.getByLabel('Timesheet year').selectOption(String(year));
}

async function download(page, buttonName) {
  const pending = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const file = await pending;
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), name: file.suggestedFilename() };
}

async function sheetOf(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.getWorksheet('Timesheet');
}

test('attendance for a complete past month is created through the real API', async ({ page }) => {
  await login(page, 'admin');
  const employees = (await apiAs(page, 'GET', '/employees')).body;
  const person = employees.find((e) => e.name === USERS.reportee.name);
  expect(person, 'the seeded reportee is required').toBeTruthy();
  for (const [day, checkIn, checkOut, status] of [[3, '09:00', '17:30', 'present'], [4, '09:00', '19:00', 'present'], [5, null, null, 'absent']]) {
    const res = await apiAs(page, 'POST', '/attendance', { empId: person.id, date: iso(day), status, ...(checkIn ? { checkIn, checkOut } : {}) });
    expect([201, 409]).toContain(res.status);
  }
});

test('HR picks one employee, a month and a year, and downloads the Excel timesheet', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await openTimesheet(page, { employee: USERS.reportee.name, month: target.month, year: target.year });
  const { buffer, name } = await download(page, 'Timesheet Excel');
  keep('browser-one.xlsx', buffer);
  expect(name).toBe(`monthly-timesheet-E2E-Reportee-${target.year}-${pad(target.month)}.xlsx`);

  const ws = await sheetOf(buffer);
  expect(text(ws.getCell('A1'))).toBe('MONTHLY EMPLOYEE TIMESHEET');
  expect(text(ws.getCell('A3'))).toBe(`Employee Name: ${USERS.reportee.name}`);
  expect(text(ws.getCell('G3'))).toBe(`Month: ${target.label}`);
  expect(Array.from({ length: 11 }, (_, i) => text(ws.getRow(5).getCell(i + 1)))).toEqual(
    ['S.No.', 'EMPLOYEE NAME', 'DATE', 'LOG IN', 'LOG OUT', 'REGULAR HOURS', 'OVERTIME', 'ON LEAVE', 'HOLIDAY', 'STATUS', 'TOTAL HOURS'],
  );
  // One row for every calendar day of the selected month, then TOTAL.
  expect(text(ws.getRow(5 + target.days).getCell(1))).toBe(String(target.days));
  expect(text(ws.getRow(6 + target.days).getCell(2))).toBe('TOTAL');

  // The file against what the HRMS itself holds for those days.
  const person = (await apiAs(page, 'GET', '/employees')).body.find((e) => e.name === USERS.reportee.name);
  const listed = (await apiAs(page, 'GET', `/attendance?from=${iso(1)}&to=${iso(target.days)}&page=1&limit=200`)).body;
  const stored = (listed.rows || listed).filter((r) => String(r.empId) === String(person.id));
  expect(stored.length, 'the HRMS must hold the seeded days').toBeGreaterThanOrEqual(3);
  let total = 0; let regular = 0; let overtime = 0;
  for (let day = 1; day <= target.days; day += 1) {
    const row = ws.getRow(5 + day);
    const cells = Array.from({ length: 11 }, (_, i) => text(row.getCell(i + 1)));
    const record = stored.find((r) => r.date === iso(day));
    const worked = record?.workedMinutes ?? 0;
    expect(cells[1]).toBe(USERS.reportee.name);
    expect(cells[3]).toBe(record?.checkIn || '—');
    expect(cells[4]).toBe(record?.checkOut || '—');
    expect(cells[10]).toBe(hours(worked)); // TOTAL HOURS is the server's workedMinutes
    expect(cells[5]).toBe(hours(Math.min(worked, 540))); // General shift, 09:00-18:00
    expect(cells[6]).toBe(hours(Math.max(0, worked - 540)));
    total += worked; regular += Math.min(worked, 540); overtime += Math.max(0, worked - 540);
  }
  const day3 = Array.from({ length: 11 }, (_, i) => text(ws.getRow(8).getCell(i + 1)));
  const day4 = Array.from({ length: 11 }, (_, i) => text(ws.getRow(9).getCell(i + 1)));
  expect(day3.slice(3, 7).concat(day3[10])).toEqual(['09:00', '17:30', '8:30', '0', '8:30']);
  expect(day4.slice(3, 7).concat(day4[10])).toEqual(['09:00', '19:00', '9:00', '1:00', '10:00']);
  const totals = Array.from({ length: 11 }, (_, i) => text(ws.getRow(6 + target.days).getCell(i + 1)));
  expect([totals[5], totals[6], totals[10]]).toEqual([hours(regular), hours(overtime), hours(total)]);
  expect(regular + overtime).toBe(total);
});

test('the PDF timesheet downloads for the same selection', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await openTimesheet(page, { employee: USERS.reportee.name, month: target.month, year: target.year });
  const { buffer, name } = await download(page, 'Timesheet PDF');
  keep('browser-one.pdf', buffer);
  expect(name).toBe(`monthly-timesheet-E2E-Reportee-${target.year}-${pad(target.month)}.pdf`);
  expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buffer.length).toBeGreaterThan(3000);
});

test('All Employees, and a different year, both produce the matching report', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await openTimesheet(page, { employee: 'all', month: target.month, year: target.year });
  const all = await download(page, 'Timesheet Excel');
  keep('browser-all.xlsx', all.buffer);
  expect(all.name).toBe(`monthly-timesheet-All-Employees-${target.year}-${pad(target.month)}.xlsx`);
  const ws = await sheetOf(all.buffer);
  expect(text(ws.getCell('A3'))).toBe('Employee Name: All Employees');
  expect(text(ws.getCell('G3'))).toBe(`Month: ${target.label}`);
  const names = [];
  for (let r = 6; text(ws.getRow(r).getCell(2)) !== 'TOTAL'; r += 1) names.push(text(ws.getRow(r).getCell(2)));
  const distinct = [...new Set(names)];
  expect(distinct.length).toBeGreaterThan(1);
  expect(names.length).toBe(distinct.length * target.days); // every employee, every day
  expect(distinct).toEqual([...distinct].sort((a, b) => a.localeCompare(b)));
  expect(distinct).toContain(USERS.reportee.name);

  const allPdf = await download(page, 'Timesheet PDF');
  keep('browser-all.pdf', allPdf.buffer);
  expect(allPdf.name).toBe(`monthly-timesheet-All-Employees-${target.year}-${pad(target.month)}.pdf`);

  // A different year: same month name, that year, and none of this year's data.
  const otherYear = target.year - 1;
  await page.getByLabel('Timesheet employee').selectOption({ label: USERS.reportee.name });
  await page.getByLabel('Timesheet year').selectOption(String(otherYear));
  const old = await download(page, 'Timesheet Excel');
  const oldSheet = await sheetOf(old.buffer);
  expect(old.name).toBe(`monthly-timesheet-E2E-Reportee-${otherYear}-${pad(target.month)}.xlsx`);
  expect(text(oldSheet.getCell('G3'))).toBe(`Month: ${MONTH_NAMES[target.month - 1]} ${otherYear}`);
});

test('an employee does not get the timesheet controls', async ({ page }) => {
  await login(page, 'reportee');
  await page.goto('/attendance');
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Timesheet employee')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Timesheet PDF', exact: true })).toHaveCount(0);
});
