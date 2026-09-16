import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';

/**
 * LEAVE, end to end in the browser: an employee raises a request through the
 * real form, their REPORTING MANAGER clears stage 1 through the real button,
 * HR clears stage 2, and the server-side ledger balance moves accordingly.
 *
 * The balance assertions read GET /leaves/balance — the same ledger the server
 * reserves against — because a balance the browser computes for itself proves
 * nothing about what the server will allow.
 */

// Serial AND no retries: these steps build on one another against real rows,
// so replaying them would re-file a leave that already exists (409
// OVERLAPPING_LEAVE) and compare against a balance that has already moved. A
// flake here has to be visible rather than retried away.
test.describe.configure({ mode: 'serial', retries: 0 });

/** Two working days, comfortably in the future, as yyyy-mm-dd. */
function futureWorkdays(offsetDays = 30) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const start = d.toISOString().slice(0, 10);
  const e = new Date(d);
  e.setDate(e.getDate() + 1);
  while (e.getDay() === 0 || e.getDay() === 6) e.setDate(e.getDate() + 1);
  return { start, end: e.toISOString().slice(0, 10) };
}

const dialog = (page) => page.locator('.modal[role="dialog"]');

async function openLeavePage(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /leave/i }).first().click();
  await expect(page.getByRole('button', { name: /New request/i })).toBeVisible({ timeout: 20_000 });
}

async function raiseRequest(page, { start, end, reason, type }) {
  await page.getByRole('button', { name: /New request/i }).click();
  const modal = dialog(page);
  await expect(modal).toBeVisible();
  if (type) await modal.locator('select').nth(1).selectOption(type);
  await modal.locator('input[type="date"]').nth(0).fill(start);
  await modal.locator('input[type="date"]').nth(1).fill(end);
  await modal.locator('textarea').fill(reason);

  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/leaves') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await modal.getByRole('button', { name: /Raise request/i }).click();
  return posted;
}

function balanceOf(sheet, type) {
  return sheet.balances.find((b) => b.type === type);
}

let raisedLeaveId = null;
let quotaBefore = null;

test.describe('an employee raises leave through the real form', () => {
  test('the balance shown on the page comes from the server ledger', async ({ page }) => {
    await openLeavePage(page, 'employee');
    const sheet = await apiAs(page, 'GET', '/leaves/balance');
    expect(sheet.status).toBe(200);

    const casual = balanceOf(sheet.body, 'casual');
    expect(casual, 'the seeded tenant should have a casual leave type').toBeTruthy();
    quotaBefore = casual;

    // Whatever the server says, the page must show THAT — not a number of its
    // own making.
    await expect(page.locator('.balance-grid')).toContainText(casual.name, { timeout: 15_000 });
    await expect(page.locator('.balance-grid')).toContainText(String(casual.available));
  });

  test('raising a request reserves days against the real balance', async ({ page }) => {
    await openLeavePage(page, 'employee');
    const { start, end } = futureWorkdays(30);

    const response = await raiseRequest(page, { start, end, type: 'casual', reason: 'E2E casual leave' });
    expect(response.status()).toBe(201);
    const created = await response.json();
    raisedLeaveId = created.id;
    expect(created.status).toBe('pending');

    // Visible in the list the employee is looking at.
    await expect(page.locator('.leave-list')).toContainText('E2E casual leave', { timeout: 15_000 });

    // And RESERVED server-side: pending up, available down, by the working days.
    const after = balanceOf((await apiAs(page, 'GET', '/leaves/balance')).body, 'casual');
    expect(after.pending).toBe(quotaBefore.pending + created.workingDays);
    expect(after.available).toBe(quotaBefore.available - created.workingDays);
  });

  test('the employee cannot approve their own request', async ({ page }) => {
    await openLeavePage(page, 'employee');
    const row = page.locator('.leave-item', { hasText: 'E2E casual leave' });
    await expect(row).toBeVisible();
    // No affordance in the UI...
    await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // ...and the API refuses it too, which is the part that matters.
    const res = await apiAs(page, 'POST', `/leaves/${raisedLeaveId}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  test('an unrelated colleague cannot decide it either', async ({ page }) => {
    // Finance has no Leave page at all, so this one is API-only from inside
    // their real signed-in browser session.
    await page.goto('/');
    await logout(page);
    await login(page, 'finance');
    const res = await apiAs(page, 'POST', `/leaves/${raisedLeaveId}/approve`);
    expect(res.status).toBe(403);
  });
});

test.describe('the approval chain runs to completion', () => {
  test('stage 1 is cleared by the requester OWN reporting manager, from the UI', async ({ page }) => {
    await openLeavePage(page, 'manager');

    const row = page.locator('.leave-item', { hasText: 'E2E casual leave' });
    await expect(row).toContainText('awaiting Reporting Manager', { timeout: 15_000 });

    const approve = row.getByRole('button', { name: 'Approve' });
    await expect(approve, 'the reporting manager must be offered the decision').toBeVisible();

    const decided = page.waitForResponse((r) => r.url().includes(`/leaves/${raisedLeaveId}/approve`), { timeout: 30_000 });
    await approve.click();
    expect((await decided).status()).toBe(200);

    // Still pending — it advanced a stage rather than being fully approved.
    const leave = await apiAs(page, 'GET', `/leaves/${raisedLeaveId}`);
    expect(leave.body.status).toBe('pending');
    expect(leave.body.currentStage).toBe(1);
  });

  test('stage 2 is cleared by HR and the days are committed', async ({ page }) => {
    await openLeavePage(page, 'hr');
    const row = page.locator('.leave-item', { hasText: 'E2E casual leave' });
    await expect(row).toContainText('awaiting HR Manager', { timeout: 15_000 });

    const decided = page.waitForResponse((r) => r.url().includes(`/leaves/${raisedLeaveId}/approve`), { timeout: 30_000 });
    await row.getByRole('button', { name: 'Approve' }).click();
    expect((await decided).status()).toBe(200);

    const leave = await apiAs(page, 'GET', `/leaves/${raisedLeaveId}`);
    expect(leave.body.status).toBe('approved');

    // The reservation became consumption: pending back down, used up.
    const sheet = await apiAs(page, 'GET', `/leaves/balance?empId=${leave.body.empId}`);
    const casual = balanceOf(sheet.body, 'casual');
    expect(casual.pending).toBe(quotaBefore.pending);
    expect(casual.used).toBe(quotaBefore.used + leave.body.workingDays);
  });

  test('the employee sees the approved state and the reduced balance', async ({ page }) => {
    await openLeavePage(page, 'employee');
    await page.getByRole('button', { name: /^Approved/ }).click();
    await expect(page.locator('.leave-list')).toContainText('E2E casual leave', { timeout: 15_000 });

    const casual = balanceOf((await apiAs(page, 'GET', '/leaves/balance')).body, 'casual');
    await expect(page.locator('.balance-grid')).toContainText(String(casual.available), { timeout: 15_000 });
  });

  test('an immutable ledger records the movement', async ({ page }) => {
    await openLeavePage(page, 'employee');
    const ledger = await apiAs(page, 'GET', '/leaves/ledger');
    expect(ledger.status).toBe(200);
    expect(Array.isArray(ledger.body)).toBe(true);
    const forLeave = ledger.body.filter((e) => String(e.refId) === String(raisedLeaveId));
    expect(forLeave.length, 'reservation and commitment should both be ledgered').toBeGreaterThanOrEqual(2);
    // The movement must be attributable, not an anonymous number change.
    for (const entry of forLeave) {
      expect(entry.reason).toBeTruthy();
      expect(entry.refType).toBe('Leave');
    }
  });
});

test.describe('balance is enforced, not just displayed', () => {
  test('a request beyond the remaining balance is refused with a visible reason', async ({ page }) => {
    await openLeavePage(page, 'employee');

    // Far beyond any annual quota.
    const start = futureWorkdays(90).start;
    const end = new Date(new Date(start).getTime() + 120 * 86_400_000).toISOString().slice(0, 10);

    const response = await raiseRequest(page, { start, end, type: 'casual', reason: 'E2E over-quota' });
    // 409, not 400: the request is well-formed, it conflicts with the balance.
    expect(response.status()).toBe(409);
    const refusal = await response.json();
    expect(refusal.error.code).toBe('INSUFFICIENT_BALANCE');
    // The refusal must be specific enough to act on.
    expect(refusal.error.available).toBeGreaterThanOrEqual(0);
    expect(refusal.error.requested).toBeGreaterThan(refusal.error.available);

    // The person must be told, in the form they are looking at.
    await expect(dialog(page)).toContainText(/balance|day/i, { timeout: 15_000 });

    // And nothing was reserved.
    const casual = balanceOf((await apiAs(page, 'GET', '/leaves/balance')).body, 'casual');
    expect(casual.pending).toBe(quotaBefore.pending);
  });
});
