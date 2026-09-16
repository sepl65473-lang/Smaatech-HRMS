import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * ATTENDANCE CORRECTIONS, through the real UI.
 *
 * This is the one path that can change an attendance record WITHOUT a face
 * capture, so it is the path worth watching: an employee asks, HR decides, and
 * the resulting row must carry the correction's own provenance rather than
 * looking like a verified punch.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

let correctionId = null;
let correctionDate = null;

async function openCorrections(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /attendance/i }).first().click();
  await page.getByRole('button', { name: /corrections/i }).first().click();
  // HR and an employee see different controls on this tab — HR decides, the
  // employee asks — so wait for the panel itself, not for one role's button.
  await expect(
    page.getByRole('button', { name: /Request Correction/i })
      .or(page.locator('.table').first())
      .or(page.locator('.empty').first())
      .first(),
  ).toBeVisible({ timeout: 20_000 });
}

const modalField = (page, label) =>
  page.locator('.modal[role="dialog"]')
    .locator(`.field:has(> .field-label:text-is("${label}"))`)
    .locator('input, textarea').first();

test.describe('an employee asks for a correction', () => {
  test('the request goes through the real form', async ({ page }) => {
    await openCorrections(page, 'manager');

    // A past day, so it is a correction rather than a punch.
    const d = new Date();
    d.setDate(d.getDate() - 3);
    correctionDate = d.toISOString().slice(0, 10);

    await page.getByRole('button', { name: /Request Correction/i }).click();
    await modalField(page, 'Date to Correct').fill(correctionDate);
    await modalField(page, 'Check-in Time (24h)').fill('09:15');
    await modalField(page, 'Check-out Time (24h)').fill('18:30');
    await modalField(page, 'Reason / Justification').fill('Camera failed at the door; security logged me in manually.');

    const submitted = page.waitForResponse(
      (r) => r.url().includes('/api/v1/attendance-corrections') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /Submit Request/i }).click();
    const response = await submitted;
    expect(response.status()).toBe(201);

    const created = await response.json();
    correctionId = created.id;
    expect(String(created.status).toLowerCase()).toBe('pending');
    expect(created.date).toBe(correctionDate);
  });

  test('an employee cannot approve their own correction', async ({ page }) => {
    await openCorrections(page, 'manager');
    const res = await apiAs(page, 'POST', `/attendance-corrections/${correctionId}/approve`);
    expect(res.status).toBe(403);
  });

  test('an employee sees only their own requests', async ({ page }) => {
    await openCorrections(page, 'manager');
    const res = await apiAs(page, 'GET', '/attendance-corrections');
    expect(res.status).toBe(200);
    for (const row of res.body) {
      expect(row.employeeName || row.name).toBe(USERS.manager.name);
    }
  });

  test('a malformed time is refused', async ({ page }) => {
    await openCorrections(page, 'manager');
    const employees = await apiAs(page, 'GET', '/employees');
    const own = employees.body.find((e) => e.name === USERS.manager.name);

    // The real field names — otherwise this would pass merely because the
    // payload was missing them, and prove nothing about time validation.
    const malformed = await apiAs(page, 'POST', '/attendance-corrections', {
      employeeId: own.id, date: correctionDate,
      requestedCheckIn: '25:99', requestedCheckOut: '18:00', reason: 'Bad time',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toMatch(/HH:MM/);

    const noReason = await apiAs(page, 'POST', '/attendance-corrections', {
      employeeId: own.id, date: correctionDate,
      requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: '   ',
    });
    expect(noReason.status).toBe(400);

    const future = new Date();
    future.setDate(future.getDate() + 5);
    const futureDated = await apiAs(page, 'POST', '/attendance-corrections', {
      employeeId: own.id, date: future.toISOString().slice(0, 10),
      requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Time travel',
    });
    expect(futureDated.status).toBe(400);
  });
});

test.describe('HR decides', () => {
  test('HR approves it from the UI and the attendance row is updated', async ({ page }) => {
    await openCorrections(page, 'hr');

    const row = page.locator('tr', { hasText: USERS.manager.name }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    const approved = page.waitForResponse(
      (r) => r.url().includes(`/attendance-corrections/${correctionId}/approve`),
      { timeout: 30_000 },
    );
    await row.getByRole('button', { name: 'Approve' }).click();
    expect((await approved).status()).toBe(200);

    // The attendance record now carries the corrected times.
    const attendance = await apiAs(page, 'GET', `/attendance?date=${correctionDate}`);
    const rows = Array.isArray(attendance.body) ? attendance.body : attendance.body.rows;
    const corrected = rows.find((r) => r.name === USERS.manager.name);
    expect(corrected).toBeTruthy();
    expect(corrected.checkIn).toContain('09:15');
    expect(corrected.checkOut).toContain('18:30');
  });

  test('the corrected row is marked as a correction, not as a verified punch', async ({ page }) => {
    await openCorrections(page, 'hr');
    const attendance = await apiAs(page, 'GET', `/attendance?date=${correctionDate}`);
    const rows = Array.isArray(attendance.body) ? attendance.body : attendance.body.rows;
    const corrected = rows.find((r) => r.name === USERS.manager.name);

    // Whatever wording the row carries, it must not claim a face match that
    // never happened.
    const asText = JSON.stringify(corrected).toLowerCase();
    expect(asText).toMatch(/correct/);
    expect(corrected.checkInVerification?.face?.matched).not.toBe(true);
  });

  test('the same correction cannot be approved twice', async ({ page }) => {
    await openCorrections(page, 'hr');
    const again = await apiAs(page, 'POST', `/attendance-corrections/${correctionId}/approve`);
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  test('the decision is on the audit trail', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'admin');
    const logs = await apiAs(page, 'GET', '/audit-logs');
    const rows = Array.isArray(logs.body) ? logs.body : (logs.body.rows || []);
    expect(rows.some((l) => /correction/i.test(l.action || ''))).toBe(true);
  });
});

test.describe('rejection', () => {
  test('HR rejects a second request with a reason, and attendance is untouched', async ({ page }) => {
    await openCorrections(page, 'manager');
    const employees = await apiAs(page, 'GET', '/employees');
    const own = employees.body.find((e) => e.name === USERS.manager.name);

    const d = new Date();
    d.setDate(d.getDate() - 4);
    const date = d.toISOString().slice(0, 10);

    const raised = await apiAs(page, 'POST', '/attendance-corrections', {
      employeeId: own.id, date,
      requestedCheckIn: '08:00', requestedCheckOut: '17:00', reason: 'Forgot to punch out',
    });
    expect(raised.status).toBe(201);

    await openCorrections(page, 'hr');
    const rejected = await apiAs(page, 'POST', `/attendance-corrections/${raised.body.id}/reject`, {
      note: 'No supporting evidence from security.',
    });
    expect(rejected.status).toBe(200);
    expect(String(rejected.body.status).toLowerCase()).toBe('rejected');

    const attendance = await apiAs(page, 'GET', `/attendance?date=${date}`);
    const rows = Array.isArray(attendance.body) ? attendance.body : attendance.body.rows;
    const untouched = rows.find((r) => r.name === USERS.manager.name);
    if (untouched) expect(untouched.checkIn).not.toContain('08:00');
  });
});
