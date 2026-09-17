import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { login } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * REAL BROWSER EXPORT VERIFICATION over a MULTI-MONTH dataset.
 *
 * Why this is separate from 12-reporting's export test: that one compares the
 * download against the server total, but the E2E tenant holds fewer rows than
 * the server's 100-row unpaged cap, so a truncated export and a complete one
 * look identical there. It could never have caught the defect it appears to
 * cover.
 *
 * This spec builds its own history that crosses the cap and spans twelve
 * months, then downloads the actual files and reads them back.
 *
 * It is numbered last on purpose: it adds attendance rows to the shared
 * isolated tenant, and doing that earlier would move counts other specs
 * assert on. Nothing here touches production - the whole stack is the
 * throwaway replica set created by global-setup.
 */

const MONTHS = 12;
const DAYS_PER_MONTH = 12; // 144 rows per employee: comfortably past the 100 cap.

/** YYYY-MM-DD for a given month offset back from the current month. */
function historicDate(monthsBack, day) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  d.setUTCDate(day);
  return d.toISOString().slice(0, 10);
}

let seeded = 0;

/**
 * Read the real total from the server inside each test.
 *
 * This was module-level state set by the seeding test. On a Playwright retry
 * only the failing test reruns, so the value was 0 and the comparison passed
 * or failed for reasons unrelated to the export.
 */
async function totalRows(page) {
  const paged = await apiAs(page, 'GET', '/attendance?page=1&limit=200');
  return paged.body.total;
}

test.beforeAll(() => {
  test.setTimeout(300_000);
});

test('a multi-month attendance history is created through the real API', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page, 'admin');

  const employees = (await apiAs(page, 'GET', '/employees')).body;
  expect(Array.isArray(employees), 'employees must come back as a list').toBe(true);
  const target = employees.find((e) => e.name === USERS.reportee.name) || employees[0];
  expect(target, 'a seeded employee is required').toBeTruthy();

  for (let m = 1; m <= MONTHS; m += 1) {
    for (let d = 1; d <= DAYS_PER_MONTH; d += 1) {
      const date = historicDate(m, d);
      const res = await apiAs(page, 'POST', '/attendance', {
        empId: target.id,
        date,
        status: d % 6 === 0 ? 'absent' : 'present',
        checkIn: '09:30',
        checkOut: '18:30',
      });
      // 409 means the row already exists from a previous run of this spec.
      if (res.status === 201) seeded += 1;
      else expect([201, 409]).toContain(res.status);
    }
  }

  const serverTotal = await totalRows(page);
  console.log(`[export] seeded ${seeded} rows; server now holds ${serverTotal} attendance rows`);

  // The whole point: the dataset must exceed the unpaged cap, or this spec
  // proves nothing.
  expect(serverTotal).toBeGreaterThan(100);
});

test('the unpaged endpoint really is capped, so the old export path WAS truncating', async ({ page }) => {
  await login(page, 'admin');
  const serverTotal = await totalRows(page);
  const unpaged = await apiAs(page, 'GET', '/attendance');
  expect(Array.isArray(unpaged.body)).toBe(true);
  // This is the list the page hydrates from, and what exports used to use.
  expect(unpaged.body.length).toBeLessThanOrEqual(100);
  expect(unpaged.body.length).toBeLessThan(serverTotal);
  console.log(`[export] unpaged endpoint returns ${unpaged.body.length} of ${serverTotal} rows`);
});

async function download(page, buttonName) {
  // Navigate by route rather than by clicking a nav item: the export controls
  // live on the Attendance page itself, and going straight there keeps this
  // spec about the export rather than about sidebar markup.
  await page.goto('/attendance');
  const button = page.getByRole('button', { name: buttonName, exact: true }).last();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  const pending = page.waitForEvent('download', { timeout: 120_000 });
  await button.click();
  const file = await pending;
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), name: file.suggestedFilename() };
}

test('CSV export contains EVERY row across twelve months, not the capped page', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'admin');
  const serverTotal = await totalRows(page);
  const { buffer } = await download(page, 'Export CSV');
  const csv = buffer.toString('utf8').trim();
  const lines = csv.split('\n');
  const dataRows = lines.length - 1;

  console.log(`[export] CSV rows: ${dataRows} (server total ${serverTotal})`);
  expect(dataRows).toBe(serverTotal);
  // Explicitly the regression guard: more than the cap.
  expect(dataRows).toBeGreaterThan(100);
  // Header must carry the columns an HR user needs - including the DATE,
  // without which a multi-month file cannot be read at all.
  const header = lines[0].toLowerCase();
  expect(header).toContain('date');
  expect(header).toContain('employee');
  expect(header).toContain('status');
});

test('Excel export opens as a real workbook with every row', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'admin');
  const serverTotal = await totalRows(page);
  const { buffer, name } = await download(page, 'Export Excel');
  expect(name).toMatch(/\.xlsx$/);

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`[export] XLSX rows: ${rows.length} (server total ${serverTotal})`);
  expect(rows.length).toBe(serverTotal);
  expect(rows.length).toBeGreaterThan(100);
  // A real workbook, not a CSV with the wrong extension.
  expect(wb.SheetNames.length).toBeGreaterThan(0);
});

test('PDF export downloads as a valid, non-trivial PDF', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'admin');
  const { buffer, name } = await download(page, 'Export PDF');
  expect(name).toMatch(/\.pdf$/);
  // Verified structurally: a real PDF header and a size consistent with many
  // rows. Extracting and reconciling every cell of a rendered PDF is beyond
  // what this suite can honestly assert, and is stated as such rather than
  // implied by a passing test.
  expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buffer.length).toBeGreaterThan(20_000);
  console.log(`[export] PDF bytes: ${buffer.length}`);
});

test('the exported dates actually span the full twelve months', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'admin');
  const { buffer } = await download(page, 'Export CSV');
  const csv = buffer.toString('utf8');

  // Every month that was seeded must appear somewhere in the file, so a range
  // that quietly loses its oldest months cannot pass.
  const missing = [];
  for (let m = 1; m <= MONTHS; m += 1) {
    const stamp = historicDate(m, 1).slice(0, 7); // YYYY-MM
    const [year, month] = stamp.split('-');
    const monthName = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
      .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (!csv.includes(stamp) && !csv.includes(monthName)) missing.push(stamp);
  }
  console.log(`[export] months missing from the file: ${missing.length ? missing.join(', ') : 'none'}`);
  expect(missing).toHaveLength(0);
});
