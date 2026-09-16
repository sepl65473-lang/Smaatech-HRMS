import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';

/**
 * REPORTING AND EXPORTS, through the real UI.
 *
 * Every figure on this page used to be computed in the browser from whatever
 * the app shell had hydrated — and the attendance list caps an unpaged
 * response at 100 rows, so a company of any size was shown an attendance rate
 * derived from a day or two of data. The CSV export had the same flaw and
 * looked complete.
 *
 * So the assertions here are about provenance: the page shows what the SERVER
 * aggregated, and the export contains every row rather than the page's.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

/** The date controls define the reporting window the page is showing. */
async function readRange(page) {
  const inputs = page.locator('input[type="date"]');
  return { from: await inputs.nth(0).inputValue(), to: await inputs.nth(1).inputValue() };
}

async function openAnalytics(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /analytics|reports/i }).first().click();
  await expect(page.locator('.card-title', { hasText: 'Department health' })).toBeVisible({ timeout: 20_000 });
}

test.describe('the figures come from the server', () => {
  test('the headline attendance rate matches the aggregation exactly', async ({ page }) => {
    await openAnalytics(page, 'admin');

    // Whatever window the page opened on, read the same one from the API. The
    // date controls ARE the range, so they are the honest source for it.
    const { from, to } = await readRange(page);
    expect(from, 'the page should show the window it is reporting on').toBeTruthy();

    const overview = await apiAs(page, 'GET', `/analytics/overview?from=${from}&to=${to}`);
    expect(overview.status).toBe(200);

    if (overview.body.attendance.ratePct == null) {
      // "No data" and "nobody came in" must not look the same.
      await expect(page.locator('.stats').first()).toContainText('nothing marked in this window');
    } else {
      await expect(page.locator('.stats').first())
        .toContainText(`${overview.body.attendance.ratePct}%`);
    }
  });

  test('changing the date range re-queries the server', async ({ page }) => {
    await openAnalytics(page, 'admin');

    const requested = page.waitForResponse(
      (r) => r.url().includes('/analytics/overview') && r.url().includes('from=2026-01-01'),
      { timeout: 30_000 },
    );
    await page.locator('input[type="date"]').first().fill('2026-01-01');
    expect((await requested).status()).toBe(200);
  });

  test('workforce movement is shown with the denominator behind the rate', async ({ page }) => {
    await openAnalytics(page, 'admin');
    const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Workforce movement' }) });
    await expect(card).toBeVisible({ timeout: 20_000 });

    const workforce = await apiAs(page, 'GET', '/analytics/workforce');
    expect(workforce.status).toBe(200);
    // An attrition percentage with no headcount behind it is not checkable.
    await expect(card).toContainText(`${workforce.body.headcount.average} average headcount`);
  });

  test('the department table matches the aggregation, department by department', async ({ page }) => {
    await openAnalytics(page, 'admin');
    const { from, to } = await readRange(page);
    const overview = await apiAs(page, 'GET', `/analytics/overview?from=${from}&to=${to}`);
    const table = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Department health' }) })
      .locator('.table');

    for (const dept of overview.body.departments) {
      // eslint-disable-next-line no-await-in-loop
      await expect(table).toContainText(dept.dept);
    }
  });
});

test.describe('exports are complete', () => {
  test('an attendance export contains EVERY row, not the page the UI holds', async ({ page }) => {
    await openAnalytics(page, 'admin');

    // What the server actually holds.
    const firstPage = await apiAs(page, 'GET', '/attendance?page=1&limit=500');
    const total = firstPage.body.total ?? firstPage.body.rows?.length ?? 0;
    expect(total, 'the tenant should have attendance rows by now').toBeGreaterThan(0);

    await page.getByRole('button', { name: /^Attendance$/ }).first().click();

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export CSV', exact: true }).last().click();
    const file = await download;

    const stream = await file.createReadStream();
    const chunks = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of stream) chunks.push(chunk);
    const csv = Buffer.concat(chunks).toString('utf8').trim();

    // Header plus one line per row — the whole dataset, not a screenful.
    const dataRows = csv.split('\n').length - 1;
    expect(dataRows).toBe(total);
  });
});

test.describe('who can read reporting', () => {
  test('an employee cannot read company-wide figures', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    for (const path of ['/analytics/overview', '/analytics/workforce', '/analytics/attendance-trend']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiAs(page, 'GET', path);
      expect(res.status, `${path} was readable`).toBe(403);
    }
  });

  test('Finance can', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'finance');
    const res = await apiAs(page, 'GET', '/analytics/overview');
    expect(res.status).toBe(200);
  });
});
