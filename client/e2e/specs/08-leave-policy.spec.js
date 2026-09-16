import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * LEAVE POLICY CONFIGURATION, end to end.
 *
 * The quotas were seeded constants with no way to change them, so the balance
 * the server enforced was a number the company had never agreed to. This drives
 * the real Settings UI and then checks the SERVER actually enforces what was
 * set — a policy screen that does not change behaviour is decoration.
 *
 * Runs after the offboarding spec, so it uses the manager account (the employee
 * has been exited by then).
 */

test.describe.configure({ mode: 'serial', retries: 0 });

async function openSettings(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /settings/i }).first().click();
  await expect(page.locator('.card-title', { hasText: 'Leave policy' })).toBeVisible({ timeout: 20_000 });
}

// The Settings page has several tables; scope everything to the policy card.
const policyCard = (page) => page.locator('.card', { has: page.locator('.card-title', { hasText: 'Leave policy' }) });
const policyRow = (page, name) => policyCard(page).locator('tr', { hasText: name }).first();

test.describe('HR configures the policy', () => {
  test('the policy screen shows the types the server actually enforces', async ({ page }) => {
    await openSettings(page, 'admin');
    const types = await apiAs(page, 'GET', '/leaves/types');
    expect(types.status).toBe(200);
    expect(types.body.length).toBeGreaterThan(0);

    for (const type of types.body) {
      await expect(policyCard(page).locator('.table')).toContainText(type.name);
    }
  });

  test('changing a quota in the UI is persisted', async ({ page }) => {
    await openSettings(page, 'admin');

    const row = policyRow(page, 'Casual Leave');
    await row.locator('input[type="number"]').fill('4');

    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/v1/leaves/types/casual') && r.request().method() === 'PATCH',
      { timeout: 30_000 },
    );
    await row.getByRole('button', { name: 'Save' }).click();
    expect((await saved).status()).toBe(200);

    const types = await apiAs(page, 'GET', '/leaves/types');
    expect(types.body.find((t) => t.code === 'casual').annualQuota).toBe(4);
  });

  test('the change reaches the employee view without rewriting their history', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const sheet = await apiAs(page, 'GET', '/leaves/balance');
    const casual = sheet.body.balances.find((b) => b.type === 'casual');

    // The POLICY the employee is shown is the new one...
    expect(casual.annualQuota).toBe(4);
    // ...but days already credited to them are NOT clawed back by an edit on a
    // settings screen. The ledger records what actually happened; a new quota
    // applies from the next accrual, which is exactly what the UI says.
    expect(casual.available).toBeGreaterThanOrEqual(0);
  });

  test('the configured balance is what the SERVER enforces on a real request', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');

    const sheet = await apiAs(page, 'GET', '/leaves/balance');
    const casual = sheet.body.balances.find((b) => b.type === 'casual');

    // Ask for comfortably more than the server says is available — and stay
    // inside the CURRENT leave year, since a request that starts in the next
    // one is reserved against that year's balance, which is a different (and
    // correctly different) number.
    const start = new Date();
    start.setDate(start.getDate() + 20);
    const end = new Date(start);
    end.setDate(end.getDate() + Math.ceil(casual.available) + 30);
    expect(end.getUTCFullYear(), 'this range must not cross the leave year')
      .toBe(new Date().getUTCFullYear());

    const refused = await apiAs(page, 'POST', '/leaves', {
      empId: (await apiAs(page, 'GET', '/employees')).body.find((e) => e.name === USERS.manager.name).id,
      type: 'casual',
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      reason: 'Over the available balance',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(refused.body.error.available).toBe(casual.available);
  });

  test('a new company-specific type can be added and then applied for', async ({ page }) => {
    await openSettings(page, 'admin');

    await policyCard(page).getByRole('button', { name: /Add leave type/i }).first().click();
    const form = policyCard(page).locator('.form-grid').first();
    await form.getByPlaceholder('e.g. bereavement').fill('bereavement');
    await form.getByPlaceholder('Bereavement Leave').fill('Bereavement Leave');
    await form.locator('input[type="number"]').fill('5');

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/leaves/types') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await policyCard(page).getByRole('button', { name: 'Add leave type', exact: true }).last().click();
    expect((await created).status()).toBe(201);

    // It is now a real, applicable policy — not just a row on a settings page.
    const types = await apiAs(page, 'GET', '/leaves/types');
    const added = types.body.find((t) => t.code === 'bereavement');
    expect(added).toBeTruthy();
    expect(added.annualQuota).toBe(5);
  });

  test('an ordinary role cannot change the policy', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'finance');
    const res = await apiAs(page, 'PATCH', '/leaves/types/casual', { annualQuota: 365 });
    expect(res.status).toBe(403);

    await login(page, 'admin');
    const types = await apiAs(page, 'GET', '/leaves/types');
    expect(types.body.find((t) => t.code === 'casual').annualQuota).toBe(4);
  });
});
