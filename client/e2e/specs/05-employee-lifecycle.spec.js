import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { PASSWORD } from '../fixtures/harness.js';

/**
 * HR / ADMIN EMPLOYEE LIFECYCLE through the real UI:
 *
 *   create -> appears in the directory -> profile page -> salary is visible to
 *   HR and hidden from peers -> edit -> deactivate -> the login stops working
 *
 * The "create a login alongside the employee" path is admin-only, so the
 * account created here is then used to sign in for real — a created employee
 * nobody can log in as is not a completed feature.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const RUN = Date.now().toString().slice(-6);
const NEW_EMP = {
  name: `E2E Hire ${RUN}`,
  role: 'Test Engineer',
  email: `e2e.hire.${RUN}@example.com`,
  salary: '640000',
};
const NEW_LOGIN_PASSWORD = 'HireLogin123';
// HR's password is temporary; the person picks this one on first sign-in.
const CHOSEN_PASSWORD = 'HireChosen456';

const dialog = (page) => page.locator('.modal[role="dialog"]');
// Exact label match: '.field', { hasText: 'Role' } would also match
// 'Login role', and hasText matches substrings.
const fieldInput = (page, label) => dialog(page)
  .locator(`.field:has(> .field-label:text-is("${label}"))`).locator('input, select, textarea').first();

/**
 * Signs in with raw credentials (the created account is not one of the seeded
 * harness users). Reloads AFTER clearing the session, so the app is actually
 * showing its login screen rather than a stale authenticated shell.
 */
async function signInAs(page, email, password) {
  await page.goto('/');
  await logout(page);
  await page.goto('/');
  const emailInput = page.locator('input[type="email"]');
  await expect(emailInput).toBeVisible({ timeout: 20_000 });
  await emailInput.fill(email);
  await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

let createdEmpId = null;
let createdUserId = null;

async function openEmployees(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /employees/i }).first().click();
  // Exact: the page also carries a separate 'Add Employee' quick action.
  await expect(page.getByRole('button', { name: 'Add employee', exact: true })).toBeVisible({ timeout: 20_000 });
}

test.describe('HR creates an employee', () => {
  test('an admin can create an employee AND its login in one step', async ({ page }) => {
    await openEmployees(page, 'admin');
    await page.getByRole('button', { name: 'Add employee', exact: true }).click();
    const modal = dialog(page);
    await expect(modal).toBeVisible();

    await fieldInput(page, 'Full name').fill(NEW_EMP.name);
    await fieldInput(page, 'Role').fill(NEW_EMP.role);
    await fieldInput(page, 'Email').fill(NEW_EMP.email);
    await fieldInput(page, 'Monthly gross (₹)').fill(NEW_EMP.salary);

    // The admin-only "also create a login" option.
    await modal.locator('input[type="checkbox"]').first().check();
    await fieldInput(page, 'Login email').fill(NEW_EMP.email);
    await modal.locator('input[type="password"]').fill(NEW_LOGIN_PASSWORD);

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/employees') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: 'Add employee', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    createdEmpId = (await response.json()).id;

    // Visible in the directory the admin is looking at.
    await expect(page.locator('body')).toContainText(NEW_EMP.name, { timeout: 20_000 });
  });

  test('the employee is persisted with the salary that was typed', async ({ page }) => {
    await openEmployees(page, 'admin');
    const list = await apiAs(page, 'GET', '/employees');
    const hire = list.body.find((e) => e.id === createdEmpId);
    expect(hire).toBeTruthy();
    expect(hire.name).toBe(NEW_EMP.name);
    expect(hire.salary).toBe(Number(NEW_EMP.salary));
    expect(hire.status).toBe('active');
  });

  test('the login that was created actually works', async ({ page }) => {
    await signInAs(page, NEW_EMP.email, NEW_LOGIN_PASSWORD);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('body')).toContainText(NEW_EMP.name, { timeout: 20_000 });
  });

  test('the new hire must choose their own password before using anything', async ({ page }) => {
    // HR set this password, so it is temporary by definition: the server
    // refuses every ordinary endpoint until the person replaces it.
    await signInAs(page, NEW_EMP.email, NEW_LOGIN_PASSWORD);
    await expect(page.locator('body')).toContainText(/Choose a new password/i, { timeout: 20_000 });

    const blocked = await apiAs(page, 'GET', '/employees');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const modal = page.locator('.modal[role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 20_000 });
    const fields = modal.locator('input[type="password"]');
    await fields.nth(0).fill(NEW_LOGIN_PASSWORD);
    await fields.nth(1).fill(CHOSEN_PASSWORD);
    if (await fields.nth(2).isVisible().catch(() => false)) {
      await fields.nth(2).fill(CHOSEN_PASSWORD);
    }

    const changed = page.waitForResponse(
      (r) => r.url().includes('/auth/change-password'), { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: /Update password|Change password|Save/i }).last().click();
    expect((await changed).status()).toBe(200);

    expect((await apiAs(page, 'GET', '/employees')).status).toBe(200);
  });

  test('the new hire sees their own salary and nobody else pay', async ({ page }) => {
    await signInAs(page, NEW_EMP.email, CHOSEN_PASSWORD);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });

    const list = await apiAs(page, 'GET', '/employees');
    const own = list.body.find((e) => e.id === createdEmpId);
    expect(own.salary).toBe(Number(NEW_EMP.salary));
    for (const other of list.body.filter((e) => e.id !== createdEmpId)) {
      expect(other.salary, `${other.name} pay leaked to a peer`).toBeUndefined();
      expect(other.bankAccount).toBeUndefined();
    }
  });
});

test.describe('HR edits and offboards', () => {
  test('an edit through the form persists', async ({ page }) => {
    await openEmployees(page, 'admin');
    const card = page.locator('.emp-card', { hasText: NEW_EMP.name }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTitle('Edit').click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await fieldInput(page, 'Role').fill('Senior Test Engineer');

    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/employees/${createdEmpId}`) && ['PATCH', 'PUT'].includes(r.request().method()),
      { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);

    await expect(page.locator('body')).toContainText('Senior Test Engineer', { timeout: 20_000 });
    const list = await apiAs(page, 'GET', '/employees');
    expect(list.body.find((e) => e.id === createdEmpId).role).toBe('Senior Test Engineer');
  });

  test('deactivating the login ends access for that account', async ({ page }) => {
    await openEmployees(page, 'admin');
    const users = await apiAs(page, 'GET', '/users');
    const account = users.body.find((u) => u.email === NEW_EMP.email);
    expect(account, 'the login created with the employee should exist').toBeTruthy();
    createdUserId = account.id;

    const patched = await apiAs(page, 'PATCH', `/users/${createdUserId}`, { active: false });
    expect(patched.status).toBe(200);

    // And the person can no longer sign in AT ALL.
    await signInAs(page, NEW_EMP.email, CHOSEN_PASSWORD);

    // Still on the login screen, with a refusal shown.
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.login-error')).toBeVisible({ timeout: 20_000 });
  });

  test('a deactivated login cannot be revived by guessing the password', async ({ page }) => {
    await signInAs(page, NEW_EMP.email, PASSWORD);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
  });
});
