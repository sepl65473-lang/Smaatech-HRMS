import { test, expect } from '@playwright/test';
import { login } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * "Attendance records" (the date-range view on the HR Attendance page) shows
 * 20 rows at a time. Driven through the real page on the isolated tenant.
 */
const pad = (n) => String(n).padStart(2, '0');
// A whole month three months back: nothing else writes there.
const base = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 3);
  const year = d.getUTCFullYear(); const month = d.getUTCMonth() + 1;
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-28`, day: (n) => `${year}-${pad(month)}-${pad(n)}` };
})();

const rowKeys = async (page) => page.locator('.attendance-page table.table').first().locator('tbody tr').evaluateAll(
  (rows) => rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim()).join(' | ')),
);

async function openRecords(page, { from, to }) {
  await page.goto('/attendance');
  const dates = page.locator('.attendance-page input[type="date"]');
  await dates.first().waitFor({ state: 'visible', timeout: 30_000 });
  await dates.nth(0).fill(from);
  await dates.nth(1).fill(to);
  await expect(page.getByText('Attendance records', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Showing \d+–\d+ of \d+ records?$/)).toBeVisible({ timeout: 30_000 });
}

test('a month of records is created through the real API', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, 'admin');
  const employees = (await apiAs(page, 'GET', '/employees')).body;
  const people = [USERS.reportee.name, USERS.manager.name].map((name) => employees.find((e) => e.name === name)).filter(Boolean);
  expect(people.length).toBe(2);
  for (const person of people) {
    for (let day = 1; day <= 28; day += 1) {
      const res = await apiAs(page, 'POST', '/attendance', {
        empId: person.id, name: person.name, dept: person.dept, date: base.day(day), status: day % 5 === 0 ? 'absent' : 'present',
        ...(day % 5 === 0 ? {} : { checkIn: '09:00', checkOut: '18:00' }),
      });
      expect([201, 409]).toContain(res.status);
    }
  }
});

test('records are shown 20 at a time; every record is reachable once, in the same order', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await openRecords(page, base);

  const listed = (await apiAs(page, 'GET', `/attendance?from=${base.from}&to=${base.to}&page=1&limit=200`)).body;
  const total = listed.total;
  expect(total).toBeGreaterThan(40); // at least three pages
  const pages = Math.ceil(total / 20);

  await expect(page.getByText(`Showing 1–20 of ${total} records`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute('aria-current', 'page');

  const seen = [];
  for (let n = 1; n <= pages; n += 1) {
    const keys = await rowKeys(page);
    const expectedCount = n < pages ? 20 : total - 20 * (pages - 1);
    expect(keys.length, `page ${n}`).toBe(expectedCount);
    await expect(page.getByText(`Showing ${(n - 1) * 20 + 1}–${Math.min(n * 20, total)} of ${total} records`)).toBeVisible();
    seen.push(...keys);
    if (n < pages) await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  expect(seen.length).toBe(total); // nothing missing
  expect(new Set(seen).size).toBe(total); // nothing twice

  // Same order as the server sends them (the order the section had before).
  const serverRows = listed.rows || listed;
  expect(serverRows.length).toBe(total);
  serverRows.forEach((r, i) => {
    expect(seen[i], `row ${i + 1}`).toContain(r.date);
    expect(seen[i], `row ${i + 1}`).toContain(r.name);
  });

  // A page number jumps straight there; Previous goes back.
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expect(page.getByText(`Showing 21–40 of ${total} records`)).toBeVisible();
  expect(await rowKeys(page)).toEqual(seen.slice(20, 40));
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  expect(await rowKeys(page)).toEqual(seen.slice(0, 20));

  // A row on a later page still opens its own details.
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  const withPunch = page.locator('.attendance-page table.table').first().locator('tbody tr').filter({ has: page.locator('button[title="View captured check-in selfie & details"]') }).first();
  const rowDate = (await withPunch.locator('td').first().innerText()).trim();
  await withPunch.locator('button[title="View captured check-in selfie & details"]').click();
  await expect(page.getByText(/— attendance detail$/)).toBeVisible();
  await expect(page.getByText(/^Check-in · 09:00$/)).toBeVisible();
  await expect(page.getByText(rowDate, { exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Page 1', exact: true }).click().catch(async () => {
    // The dialog did not close on Escape: reload and carry on from page 1.
    await openRecords(page, base);
  });

  // The columns are the ones the section already had.
  const headers = await page.locator('.attendance-page table.table').first().locator('thead th').allInnerTexts();
  expect(headers.map((h) => h.trim().toUpperCase())).toEqual(['DATE', 'EMPLOYEE', 'DEPARTMENT', 'SHIFT', 'CHECK-IN', 'CHECK-OUT', 'STATUS', 'LOCATION']);
});

test('changing a filter returns to page 1, and a result that fits one page has no page buttons', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await openRecords(page, base);

  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expect(page.getByText(/^Showing 21–40 of /)).toBeVisible();

  // Status filter: back to the first page, counting only the filtered rows.
  const statusSelect = page.locator('.attendance-page select.input').filter({ has: page.locator('option[value="absent"]') }).first();
  await statusSelect.selectOption('absent');
  const absentTotal = (await apiAs(page, 'GET', `/attendance?from=${base.from}&to=${base.to}&page=1&limit=200`)).body.rows.filter((r) => r.status === 'absent').length;
  expect(absentTotal).toBeGreaterThan(0);
  await expect(page.getByText(`Showing 1–${Math.min(20, absentTotal)} of ${absentTotal} record${absentTotal === 1 ? '' : 's'}`)).toBeVisible();
  expect((await rowKeys(page)).length).toBe(Math.min(20, absentTotal));
  if (absentTotal <= 20) {
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toHaveCount(0);
  }

  // Date filter narrowed to one day: one page again, from page 1.
  await statusSelect.selectOption('all');
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await page.locator('.attendance-page input[type="date"]').nth(1).fill(base.day(1));
  await expect(page.getByText(/^Showing 1–\d+ of \d+ records?$/)).toBeVisible();
  expect((await rowKeys(page)).length).toBeLessThanOrEqual(20);

  // A period with nothing in it: no rows and no pager, as before.
  await page.locator('.attendance-page input[type="date"]').nth(0).fill('2001-01-01');
  await page.locator('.attendance-page input[type="date"]').nth(1).fill('2001-01-02');
  await expect(page.getByText(/^Showing /)).toHaveCount(0);
  expect((await rowKeys(page)).length).toBe(0);
});

test("today's roster, the exports and the timesheet controls are untouched; the pager fits a phone-sized window", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await page.goto('/attendance');
  await expect(page.getByText('Today’s roster', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Showing /)).toHaveCount(0); // no pager on today's roster
  for (const name of ['Export CSV', 'Export Excel', 'Export PDF', 'Timesheet PDF', 'Timesheet Excel']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('Timesheet employee')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await openRecords(page, base);
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.scrollIntoViewIfNeeded();
  const box = await next.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await next.click();
  await expect(page.getByText(/^Showing 21–40 of /)).toBeVisible();
});
