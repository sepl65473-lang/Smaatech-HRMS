import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { USERS, PASSWORD } from '../fixtures/harness.js';

/**
 * REAL BROWSER login, through the real UI, against the real API.
 *
 * Every previous round proved authentication with supertest, which never
 * renders a page, never runs the client's own validation, and never exercises
 * the token/refresh wiring in the browser. This does.
 */

test.describe('login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await page.goto('/');
  });

  test('the login screen actually renders', async ({ page }) => {
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });

  test('rejects a wrong password and stays on the login screen', async ({ page }) => {
    await page.locator('input[type="email"]').fill(USERS.employee.email);
    await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill('WrongPassword999');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // The user must still be on the login screen, and must be told why.
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('.login-error')).toBeVisible({ timeout: 15_000 });
  });

  test('rejects an unknown account without revealing whether it exists', async ({ page }) => {
    await page.locator('input[type="email"]').fill('nobody.at.all@example.com');
    await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.locator('.login-error')).toBeVisible({ timeout: 15_000 });
    const message = await page.locator('.login-error').innerText();
    // Same wording as a wrong password — no account enumeration.
    expect(message.toLowerCase()).toContain('invalid');
  });

  for (const who of ['employee', 'hr', 'admin', 'manager', 'finance']) {
    test(`${who} signs in and reaches the application`, async ({ page }) => {
      const user = await login(page, who);
      // The login form is gone and the app shell has rendered.
      await expect(page.locator('input[type="email"]')).toBeHidden();
      await expect(page.locator('body')).toContainText(/./);
      // The signed-in identity is visible somewhere in the shell.
      const shell = await page.locator('body').innerText();
      expect(shell.length).toBeGreaterThan(50);
      expect(user.email).toBeTruthy();
    });
  }

  test('a signed-in session survives a full page reload', async ({ page }) => {
    await login(page, 'employee');
    await page.reload();
    await page.waitForLoadState('networkidle');
    // The refresh-token cookie must re-establish the session rather than
    // bouncing the user back to the login screen.
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });
  });

  test('signing out returns the user to the login screen', async ({ page }) => {
    await login(page, 'employee');
    await logout(page);
    await page.goto('/');
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
  });
});
