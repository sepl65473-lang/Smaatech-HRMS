import { test, expect } from '@playwright/test';
import { login } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { API_BASE, USERS } from '../fixtures/harness.js';

/**
 * A fixed face + fingerprint machine as an attendance source, end to end:
 * HR registers the device and links a device user on the real Integrations
 * page, the "device" sends a live punch to POST /api/v1/device-punch with its
 * own id and key, and the punch shows up on the HR Attendance page.
 *
 * Last in the suite: it writes today's check-in and check-out for one
 * employee, which earlier specs expect to make themselves.
 */
const DEVICE_ID = `IOT-E2E-${Date.now().toString(36).toUpperCase()}`;
const DEVICE_NAME = 'E2E Gate Terminal';
const SITE = 'Main Gate, E2E Works, Test Road, Test City 700001';
const state = { key: null };

const sendPunch = (request, body, headers = {}) => request.post(`${API_BASE}/api/v1/device-punch`, {
  headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID, 'X-Device-Key': state.key || '', ...headers },
  data: body,
});
const event = (type) => ({
  eventId: `e2e-${type}-${Date.now()}`, deviceUserId: '501', type, verification: 'face_and_fingerprint', timestamp: new Date().toISOString(),
});

test('HR registers a device, sees its key once, and links a device user to an employee', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, 'hr');
  await page.goto('/integrations');
  await expect(page.getByText('Attendance devices (face + fingerprint)')).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('Device ID').fill(DEVICE_ID);
  await page.getByLabel('Name', { exact: true }).fill(DEVICE_NAME);
  await page.getByLabel(/^Site address/).fill(SITE);
  await page.getByRole('button', { name: 'Register device', exact: true }).click();

  // The key is on screen exactly once.
  await expect(page.getByText(`Key for ${DEVICE_ID}`)).toBeVisible();
  const shown = (await page.locator('.mono', { hasText: /^[0-9a-f]{64}$/ }).first().innerText()).trim();
  expect(shown).toMatch(/^[0-9a-f]{64}$/);
  state.key = shown;
  await page.getByRole('button', { name: 'I have copied it', exact: true }).click();
  await expect(page.getByText(shown)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: DEVICE_ID, exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: SITE })).toBeVisible();

  // The list from the server never carries the key or its hash.
  const listed = await apiAs(page, 'GET', '/devices');
  expect(JSON.stringify(listed.body)).not.toContain(shown);
  expect(listed.body.find((d) => d.deviceId === DEVICE_ID)).toMatchObject({ active: true, hasKey: true, siteAddress: SITE });

  await page.getByLabel('Device to link').selectOption(DEVICE_ID);
  await page.getByLabel('Device user number').fill('501');
  await page.getByLabel('Employee to link').selectOption({ label: USERS.reportee.name });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(`${DEVICE_ID}.*501.*${USERS.reportee.name}`) })).toBeVisible();
});

test('the device API refuses a wrong key, an unlinked user, a single factor and a stale timestamp', async ({ request }) => {
  expect(state.key, 'the device must have been registered').toBeTruthy();
  expect((await sendPunch(request, event('in'), { 'X-Device-Key': 'not-the-key' })).status()).toBe(401);
  const unmapped = await sendPunch(request, { ...event('in'), deviceUserId: '999' });
  expect(unmapped.status()).toBe(404);
  expect((await unmapped.json()).error.code).toBe('DEVICE_USER_UNMAPPED');
  const oneFactor = await sendPunch(request, { ...event('in'), verification: 'face' });
  expect((await oneFactor.json()).error.code).toBe('VERIFICATION_REQUIRED');
  const stale = await sendPunch(request, { ...event('in'), timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  expect((await stale.json()).error.code).toBe('INVALID_TIMESTAMP');
});

test('a live device check-in and check-out land on the HR Attendance page with the registered site', async ({ page, request }) => {
  test.setTimeout(120_000);
  expect(state.key).toBeTruthy();
  await login(page, 'hr');
  const person = (await apiAs(page, 'GET', '/employees')).body.find((e) => e.name === USERS.reportee.name);

  const checkIn = event('in');
  const first = await sendPunch(request, checkIn);
  expect(first.status()).toBe(200);
  const inBody = await first.json();
  expect(inBody).toMatchObject({ success: true, employeeId: person.id, type: 'in' });

  // The same event again changes nothing.
  const again = await (await sendPunch(request, checkIn)).json();
  expect(again).toMatchObject({ success: true, duplicate: true, time: inBody.time, attendanceId: inBody.attendanceId });

  const out = await (await sendPunch(request, event('out'))).json();
  expect(out).toMatchObject({ success: true, type: 'out', attendanceId: inBody.attendanceId });

  // The record the HRMS holds.
  const today = (await apiAs(page, 'GET', '/attendance')).body.find((r) => r.id === inBody.attendanceId);
  expect(today).toMatchObject({
    checkIn: inBody.time, checkOut: out.time, checkInAddress: SITE, checkOutAddress: SITE,
    checkInDetails: `IoT device (${DEVICE_NAME}) · Face + Fingerprint`,
  });
  expect(today.checkInVerification).toMatchObject({ source: 'iot-device', method: 'face_and_fingerprint' });

  // And the same HR Attendance screen as every other punch.
  await page.goto('/attendance');
  const row = page.locator('.attendance-page table.table').first().locator('tbody tr', { hasText: USERS.reportee.name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(inBody.time);
  await expect(row).toContainText(SITE);
});

test('a disabled device is refused; an employee cannot open the device register', async ({ page, request }) => {
  await login(page, 'hr');
  const device = (await apiAs(page, 'GET', '/devices')).body.find((d) => d.deviceId === DEVICE_ID);
  await apiAs(page, 'PATCH', `/devices/${device.id}`, { active: false });
  const refused = await sendPunch(request, event('out'));
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('DEVICE_DISABLED');

  await login(page, 'reportee');
  expect((await apiAs(page, 'GET', '/devices')).status).toBe(403);
});
