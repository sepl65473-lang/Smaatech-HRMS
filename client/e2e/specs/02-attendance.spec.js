import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { API_BASE, E2E_SECRET, USERS } from '../fixtures/harness.js';

/**
 * FACE + ATTENDANCE, driven through the real browser UI.
 *
 * The camera is Chromium's synthetic device, so the capture path (getUserMedia
 * -> <video> -> canvas -> Blob -> multipart upload) runs for real. The identity
 * COMPARISON is the one substituted piece, and the substitution still enforces
 * the rule: the request must name which account's face it presents, and the
 * server rejects it unless that matches the signed-in account.
 */

/**
 * Calls the API as the CURRENTLY SIGNED-IN browser user.
 *
 * The app holds its access token in module memory, not in localStorage, so a
 * fetch issued from page.evaluate has no Authorization header of its own. The
 * httpOnly refresh cookie the browser already carries is exchanged for a fresh
 * access token first — exactly what the app itself does on page load. This
 * stays inside the real session; it does not mint credentials.
 */
async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body, secret }) => {
    const refreshed = await fetch('/api/v1/auth/refresh', {
      method: 'POST', credentials: 'include', headers: { 'X-E2E-Secret': secret },
    });
    if (!refreshed.ok) return { status: refreshed.status, body: { error: { code: 'NO_SESSION' } } };
    const { accessToken } = await refreshed.json();

    const res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-E2E-Secret': secret,
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { method, path, body, secret: E2E_SECRET });
}

/** Uses the REAL capture UI: opens the modal, waits for the camera, captures. */
async function captureThroughUI(page, buttonName) {
  await page.getByRole('button', { name: buttonName }).click();
  const takePhoto = page.getByRole('button', { name: 'Take Photo' });
  await expect(takePhoto).toBeVisible({ timeout: 30_000 });
  await takePhoto.click();
}

test.describe('employee attendance through the browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await logout(page);
  });

  test('the dashboard shows today attendance state before any punch', async ({ page }) => {
    await login(page, 'employee');
    await expect(page.locator('body')).toContainText(/No check-in|Check In/i, { timeout: 20_000 });
  });

  test('WITHOUT location permission, check-in is refused and nothing is sent', async ({ page }) => {
    // Geofencing is off for this tenant; location is required all the same.
    await page.context().clearPermissions();
    await page.context().grantPermissions(['camera']);
    await login(page, 'employee');

    let punchRequests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/check-in') && r.method() === 'POST') punchRequests += 1;
    });

    const checkIn = page.getByRole('button', { name: /Check In \(Face \+ GPS\)/i });
    await expect(checkIn).toBeVisible({ timeout: 20_000 });
    await checkIn.click();

    await expect(page.locator('body')).toContainText(/location/i, { timeout: 20_000 });
    // The capture modal is closed again and the employee is still not checked in.
    await expect(page.getByRole('button', { name: 'Take Photo' })).toBeHidden({ timeout: 20_000 });
    await expect(checkIn).toBeVisible();
    expect(punchRequests).toBe(0);

    const list = await apiCall(page, 'GET', '/attendance');
    expect(list.body[0].checkIn).toBeNull();
  });

  test('CHECK-IN through the real capture UI writes a verified row', async ({ page }) => {
    await login(page, 'employee');

    const checkIn = page.getByRole('button', { name: /Check In \(Face \+ GPS\)/i });
    await expect(checkIn).toBeVisible({ timeout: 20_000 });

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/check-in') && r.request().method() === 'POST',
      { timeout: 45_000 },
    );
    await captureThroughUI(page, /Check In \(Face \+ GPS\)/i);
    const response = await responsePromise;

    expect(response.status()).toBe(200);
    const row = await response.json();
    expect(row.checkIn).toBeTruthy();
    expect(row.checkInVerification.face.matched).toBe(true);
    // The browser's own position (playwright.config.js) is what was stored.
    expect(row.checkInLocation.lat).toBeCloseTo(19.0760, 4);
    expect(row.checkInLocation.lng).toBeCloseTo(72.8777, 4);
    expect(['present', 'late']).toContain(row.status);

    // The UI must reflect it, not just the API.
    await expect(page.locator('body')).toContainText(new RegExp(`In ${row.checkIn}`), { timeout: 20_000 });
  });

  test('CHECK-OUT through the real capture UI completes the day', async ({ page }) => {
    // A different position from check-in, so a reused fix would be caught.
    await page.context().setGeolocation({ latitude: 19.0800, longitude: 72.8800, accuracy: 10 });
    await login(page, 'employee');

    const checkOut = page.getByRole('button', { name: /Check Out/i }).first();
    await expect(checkOut).toBeVisible({ timeout: 20_000 });

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/check-out') && r.request().method() === 'POST',
      { timeout: 45_000 },
    );
    await captureThroughUI(page, /Check Out/i);
    const response = await responsePromise;

    expect(response.status()).toBe(200);
    const row = await response.json();
    expect(row.checkOut).toBeTruthy();
    expect(row.checkOutLocation.lat).toBeCloseTo(19.0800, 4);
    expect(row.checkOutLocation.lng).toBeCloseTo(72.8800, 4);
    expect(row.checkInLocation.lat).toBeCloseTo(19.0760, 4);
    expect(row.checkInLocation.lng).toBeCloseTo(72.8777, 4);
    await expect(page.locator('body')).toContainText(new RegExp(`Out ${row.checkOut}`), { timeout: 20_000 });
  });

  test('a DUPLICATE check-in is refused', async ({ page }) => {
    await login(page, 'employee');
    // The employee already checked in above; the row id comes from the API.
    const list = await apiCall(page, 'GET', '/attendance');
    const today = list.body[0];
    const res = await apiCall(page, 'POST', `/attendance/${today.id}/check-in`);
    expect([400, 409]).toContain(res.status);
  });
});

test.describe('face identity binding, in the browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await logout(page);
  });

  test("REJECTS a check-in presenting ANOTHER employee's face", async ({ page }) => {
    // The buddy-punching case, exercised end to end: a genuine browser session
    // for the manager, but the capture claims to be the employee's face.
    await login(page, 'manager');

    const list = await apiCall(page, 'GET', '/attendance');
    const own = list.body.find((r) => r.name === USERS.manager.name);
    expect(own).toBeTruthy();

    const otherUser = await apiCall(page, 'GET', '/employees');
    const otherEmployee = otherUser.body.find((e) => e.name === USERS.employee.name);
    expect(otherEmployee).toBeTruthy();

    const res = await page.evaluate(async ({ rowId, foreignId, secret }) => {
      const refreshed = await fetch('/api/v1/auth/refresh', {
        method: 'POST', credentials: 'include', headers: { 'X-E2E-Secret': secret },
      });
      const { accessToken } = await refreshed.json();

      const form = new FormData();
      form.append('e2eFaceUserId', foreignId);
      form.append('deviceId', 'e2e-browser');
      // A self-punch needs a location; without one it is refused before the
      // face is even looked at.
      form.append('lat', '19.0760');
      form.append('lng', '72.8777');
      // A real JPEG so the upload filter behaves exactly as in production.
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#8899aa'; ctx.fillRect(0, 0, 200, 200);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      form.append('photo', blob, 'selfie.jpg');
      const r = await fetch(`/api/v1/attendance/${rowId}/check-in`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-E2E-Secret': secret, Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { rowId: own.id, foreignId: otherEmployee.id, secret: E2E_SECRET });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FACE_NOT_MATCHED');

    // And the attendance row must be untouched.
    const after = await apiCall(page, 'GET', '/attendance');
    const stillUnchecked = after.body.find((r) => r.id === own.id);
    expect(stillUnchecked.checkIn).toBeNull();
  });

  test('a rejected attempt is recorded as HR-visible evidence', async ({ page }) => {
    await login(page, 'hr');
    const attempts = await apiCall(page, 'GET', '/attendance/verification/attempts');
    expect(attempts.status).toBe(200);
    const mismatch = attempts.body.find((a) => a.reasonCode === 'FACE_NOT_MATCHED');
    expect(mismatch, 'the rejected attempt from the previous test should be recorded').toBeTruthy();
    expect(mismatch.photoUrl).toContain('/api/v1/files/verification-attempt/');
    expect(mismatch.stage).toBe('face');
  });

  test('an EMPLOYEE cannot read verification evidence', async ({ page }) => {
    await login(page, 'employee');
    const res = await apiCall(page, 'GET', '/attendance/verification/attempts');
    expect(res.status).toBe(403);
  });
});

test.describe('HR attendance has no biometric bypass', () => {
  test('HR punching their OWN row still needs a capture', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'hr');

    const list = await apiCall(page, 'GET', '/attendance');
    const own = list.body.find((r) => r.name === USERS.hr.name);
    // With no location either, the location check refuses first — HR is not
    // exempt from that.
    const bare = await apiCall(page, 'POST', `/attendance/${own.id}/check-in`);
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('NO_COORDINATES');

    const res = await apiCall(page, 'POST', `/attendance/${own.id}/check-in`, { lat: 19.0760, lng: 72.8777 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PHOTO');
  });

  test('an HR override on another row is recorded as an override, not a face match', async ({ page }) => {
    await login(page, 'hr');
    const list = await apiCall(page, 'GET', '/attendance');
    const other = list.body.find((r) => r.name === USERS.finance.name);
    const res = await apiCall(page, 'POST', `/attendance/${other.id}/check-in`);

    expect(res.status).toBe(200);
    expect(res.body.checkInDetails).toBe('HR Manual Punch');
    expect(res.body.checkInVerification.face).toBeNull();
    expect(res.body.checkInVerification.liveness.reason).toBe('hr-override');
  });
});
