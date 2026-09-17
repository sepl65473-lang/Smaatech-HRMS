import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';

/**
 * Attendance roster: proves the compaction did not cost any information or
 * interaction.
 *
 * The roster was made shorter by trimming whitespace - the KPI cards' stacked
 * icon row and oversized table cell padding - NOT by dropping columns or
 * hiding evidence. These specs assert the things that had to survive: every
 * column, the punch photo interaction, the status control, the filters, the
 * exports, and the check-in/out values themselves.
 *
 * Runs after 02-attendance has already punched the employee in, so there is a
 * real row with real evidence to inspect rather than an empty roster.
 */

async function openRoster(page, who = 'admin') {
  await logout(page);
  await login(page, who);
  await page.goto('/attendance');
  await expect(page.getByRole('columnheader', { name: 'Employee' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
}

test('every roster column is still present', async ({ page }) => {
  await openRoster(page);
  for (const header of ['Employee', 'Department', 'Shift', 'Check-in', 'Check-out', 'Status', 'Location']) {
    await expect(
      page.getByRole('columnheader', { name: header }),
      `the "${header}" column must survive the compaction`,
    ).toBeVisible();
  }
});

test('employee avatars are still rendered in the roster', async ({ page }) => {
  await openRoster(page);
  const avatars = page.locator('tbody tr .avatar, tbody tr img');
  const count = await avatars.count();
  console.log(`[roster] avatars rendered: ${count}`);
  expect(count, 'employee photos/avatars must not be removed to save height').toBeGreaterThan(0);

  // And they must still be a usable size, not shrunk to nothing.
  const box = await avatars.first().boundingBox();
  console.log(`[roster] avatar size: ${Math.round(box.width)}x${Math.round(box.height)}`);
  expect(box.height).toBeGreaterThanOrEqual(24);
});

test('a punched-in employee shows their time and opens the captured evidence', async ({ page }) => {
  await openRoster(page);

  // Find a row that actually has a check-in time.
  const rows = await apiAs(page, 'GET', '/attendance');
  const punched = (Array.isArray(rows.body) ? rows.body : rows.body.rows || []).find((r) => r.checkIn);
  test.skip(!punched, 'no punched-in row in the tenant yet');

  console.log(`[roster] inspecting ${punched.name}: in=${punched.checkIn} out=${punched.checkOut || '—'}`);

  // The time itself must be on screen.
  await expect(page.locator('tbody')).toContainText(punched.checkIn);

  // The evidence interaction: the camera button beside the punch time.
  const evidence = page.locator('tbody [title*="selfie"]').first();
  await expect(evidence, 'the punch-evidence control must survive').toBeVisible({ timeout: 15_000 });
  await evidence.click();

  // The existing detail view opens and carries the punch details.
  const dialog = page.locator('.modal, [role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const text = await dialog.innerText();
  console.log(`[roster] detail view opened, ${text.length} chars of detail`);
  expect(text.length, 'the detail view must actually contain the punch details').toBeGreaterThan(20);
});

test('the status control and department filters still work', async ({ page }) => {
  await openRoster(page);

  // Status dropdown on a row is a real control, not a label.
  const statusSelect = page.locator('tbody select').first();
  await expect(statusSelect).toBeVisible();
  await expect(statusSelect).toBeEnabled();

  // Department chips filter the list.
  const before = await page.locator('tbody tr').count();
  const chip = page.getByRole('button', { name: 'Engineering', exact: true }).first();
  if (await chip.isVisible().catch(() => false)) {
    await chip.click();
    await page.waitForTimeout(600);
    const after = await page.locator('tbody tr').count();
    console.log(`[roster] department filter: ${before} rows -> ${after} rows`);
    expect(after).toBeLessThanOrEqual(before);
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(400);
    expect(await page.locator('tbody tr').count()).toBe(before);
  }
});

test('the exports still produce a file', async ({ page }) => {
  await openRoster(page);
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const file = await pending;
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8').trim();
  console.log(`[roster] CSV export: ${csv.split('\n').length - 1} data rows`);
  expect(csv.split('\n').length - 1).toBeGreaterThan(0);
});

test('the roster fits a laptop viewport without horizontal overflow', async ({ page }) => {
  for (const [w, h] of [[1440, 900], [1366, 768], [1280, 720], [1024, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await openRoster(page);
    const m = await page.evaluate((vh) => {
      const rows = [...document.querySelectorAll('tbody tr')];
      const firstTop = rows.length ? Math.round(rows[0].getBoundingClientRect().top) : null;
      const visible = rows.filter((r) => {
        const b = r.getBoundingClientRect();
        return b.top < vh && b.bottom > 0;
      }).length;
      return {
        firstTop,
        visible,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    }, h);
    console.log(`[roster] ${w}x${h}: first row at ${m.firstTop}px, ${m.visible} rows visible`);
    expect(m.scrollW, `no horizontal overflow at ${w}px`).toBeLessThanOrEqual(m.clientW + 1);
    // The header chrome must not eat most of a laptop screen before any data.
    if (w >= 1280) expect(m.firstTop, 'too much chrome above the first row').toBeLessThanOrEqual(420);
  }
});
