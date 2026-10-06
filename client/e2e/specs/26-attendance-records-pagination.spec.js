import { test, expect } from '@playwright/test';
import { login } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * "Attendance records" (the date-range view on the HR Attendance page) shows
 * 20 rows at a time. Driven through the real page on the isolated tenant.
 */
const pad = (n) => String(n).padStart(2, '0');
// A month fifteen months back: outside the twelve months 19-exports fills.
const base = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 15);
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

const TODAY_TITLE = 'Today Attendance Records';
const todaysRows = async (page) => {
  const list = (await apiAs(page, 'GET', '/attendance')).body;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { today, all: list, rows: list.filter((r) => r.date === today) };
};

test('the default view is "Today Attendance Records": today only, and 20 or fewer rows have no page buttons', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
  await page.goto('/attendance');
  // Both the tab button and the card heading carry the new name.
  await expect(page.getByRole('button', { name: TODAY_TITLE, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.card-title', { hasText: TODAY_TITLE })).toBeVisible();
  await expect(page.getByText(/Today.s roster/)).toHaveCount(0);

  const { all, rows } = await todaysRows(page);
  expect(all.length).toBeGreaterThan(rows.length); // earlier days ARE in the loaded list...
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(20);
  // ...but only today's rows are listed.
  await expect(page.getByText(`Showing 1–${rows.length} of ${rows.length} record${rows.length === 1 ? '' : 's'}`)).toBeVisible();
  await expect(page.getByText(`${rows.length} of ${rows.length} people shown`)).toBeVisible();
  const keys = await rowKeys(page);
  expect(keys.length).toBe(rows.length);
  rows.forEach((r, i) => { if (r.name) expect(keys[i]).toContain(r.name); });
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toHaveCount(0);

  // Summary cards are today's figures.
  for (const [label, status] of [['Absent', 'absent'], ['On leave', 'leave']]) {
    await expect(page.locator('.stat', { hasText: label }).locator('.stat-value')).toHaveText(String(rows.filter((r) => r.status === status).length));
  }

  // Nothing else on the page moved.
  for (const name of ['Export CSV', 'Export Excel', 'Export PDF', 'Timesheet PDF', 'Timesheet Excel']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const label of ['Timesheet employee', 'Timesheet month', 'Timesheet year']) await expect(page.getByLabel(label)).toBeVisible();
  const headers = await page.locator('.attendance-page table.table').first().locator('thead th').allInnerTexts();
  expect(headers.map((h) => h.trim().toUpperCase())).toEqual(['EMPLOYEE', 'DEPARTMENT', 'SHIFT', 'CHECK-IN', 'CHECK-OUT', 'STATUS', 'LOCATION']);
});

test('the pager fits a phone-sized window', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'hr');
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

// Last on purpose: it adds employees to the shared tenant.
test('more than 20 records today: page 1 has 20, the rest follow, and a filter returns to page 1', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page, 'admin');
  const before = await todaysRows(page);
  const toAdd = Math.max(0, 23 - before.rows.length); // 23 today: pages of 20 and 3
  for (let i = 1; i <= toAdd; i += 1) {
    const created = await apiAs(page, 'POST', '/employees', {
      name: `Pager Person ${String(i).padStart(2, '0')}`, role: 'Associate', dept: i % 2 ? 'Engineering' : 'Design',
      loc: 'Bengaluru', email: `pager.person${i}.${Date.now()}@example.com`, status: 'active', joinDate: before.today,
    });
    expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(201);
    const row = await apiAs(page, 'POST', '/attendance', { empId: created.body.id, name: created.body.name, dept: created.body.dept, date: before.today, status: 'absent' });
    expect([201, 409]).toContain(row.status);
  }
  const { rows } = await todaysRows(page);
  const total = rows.length;
  expect(total).toBe(23);

  await page.goto('/attendance');
  await expect(page.locator('.card-title', { hasText: TODAY_TITLE })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`Showing 1–20 of ${total} records`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Page 3', exact: true })).toHaveCount(0); // two pages, not more
  const first = await rowKeys(page);
  expect(first.length).toBe(20);

  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await expect(page.getByText(`Showing 21–${total} of ${total} records`)).toBeVisible();
  const second = await rowKeys(page);
  expect(second.length).toBe(total - 20);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  const seen = [...first, ...second];
  expect(new Set(seen).size).toBe(total); // every person once
  rows.forEach((r, i) => expect(seen[i], `row ${i + 1}`).toContain(r.name)); // the order the list already had

  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  expect(await rowKeys(page)).toEqual(first);

  // The cards count all of today's rows, not just the 20 on screen.
  await expect(page.locator('.stat', { hasText: 'Absent' }).locator('.stat-value')).toHaveText(String(rows.filter((r) => r.status === 'absent').length));

  // A department chip chosen on page 2 returns to page 1 of today's filtered rows.
  await page.getByRole('button', { name: 'Page 2', exact: true }).click();
  await page.locator('.attendance-page .filter-chips button', { hasText: /^Design$/ }).click();
  const design = rows.filter((r) => r.dept === 'Design').length;
  expect(design).toBeGreaterThan(0);
  await expect(page.getByText(`Showing 1–${Math.min(20, design)} of ${design} record${design === 1 ? '' : 's'}`)).toBeVisible();
  expect((await rowKeys(page)).length).toBe(Math.min(20, design));
});
