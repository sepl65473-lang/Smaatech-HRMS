import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { E2E_SECRET, PASSWORD, USERS } from '../fixtures/harness.js';

/**
 * ACCOUNT SECURITY in a real browser: the temporary-password gate, password
 * change, brute-force lockout, and what a signed-out or revoked session can
 * still reach.
 *
 * The temporary-password requirement was a banner and a modal and nothing
 * else — the page behind it rendered and every endpoint answered, so anyone
 * holding the emailed password had the whole application without ever changing
 * it. That is the main thing driven here.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const RUN = Date.now().toString().slice(-6);
const STARTER = {
  name: `E2E Starter ${RUN}`,
  email: `e2e.starter.${RUN}@example.com`,
  temp: 'TempPass123',
  chosen: 'ChosenPass456',
};

let starterUserId = null;

/** Signs in with raw credentials and waits for the app shell. */
async function signIn(page, email, password) {
  await page.goto('/');
  await logout(page);
  await page.goto('/');
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('an account created with a temporary password', () => {
  test('is created by an admin and marked as needing a password change', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'admin');

    const created = await apiAs(page, 'POST', '/users', {
      name: STARTER.name, email: STARTER.email, password: STARTER.temp, role: 'Employee',
    });
    expect(created.status).toBe(201);
    starterUserId = created.body.id;
    // The server marks it, so the client can put the person straight into the form.
    expect(created.body.mustChangePassword).toBe(true);
  });

  test('can sign in, and is told to change the password', async ({ page }) => {
    await signIn(page, STARTER.email, STARTER.temp);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('body')).toContainText(/Choose a new password/i, { timeout: 20_000 });
  });

  test('CANNOT use the application until the password is changed', async ({ page }) => {
    await signIn(page, STARTER.email, STARTER.temp);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });

    // Not merely hidden in the UI — the API refuses, which is what stops
    // someone who simply closes the modal or calls the endpoint directly.
    for (const path of ['/employees', '/attendance', '/payroll', '/leaves']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiAs(page, 'GET', path);
      expect(res.status, `${path} was reachable on a temporary password`).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  test('changing the password through the real form unlocks the app', async ({ page }) => {
    await signIn(page, STARTER.email, STARTER.temp);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });

    const modal = page.locator('.modal[role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 20_000 });

    const fields = modal.locator('input[type="password"]');
    await fields.nth(0).fill(STARTER.temp);
    await fields.nth(1).fill(STARTER.chosen);
    if (await fields.nth(2).isVisible().catch(() => false)) {
      await fields.nth(2).fill(STARTER.chosen);
    }

    const changed = page.waitForResponse(
      (r) => r.url().includes('/auth/change-password') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: /Update password|Change password|Save/i }).last().click();
    expect((await changed).status()).toBe(200);

    // Working immediately — no reload, no waiting out a cache.
    const res = await apiAs(page, 'GET', '/employees');
    expect(res.status).toBe(200);
  });

  test('the new password works and the temporary one does not', async ({ page }) => {
    await signIn(page, STARTER.email, STARTER.chosen);
    await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });

    await signIn(page, STARTER.email, STARTER.temp);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.login-error')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('brute force', () => {
  test('repeated wrong passwords lock the account, and the message does not leak', async ({ page }) => {
    await page.goto('/');
    await logout(page);

    let lastBody = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      lastBody = await page.evaluate(async ({ email, secret }) => {
        const res = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-E2E-Secret': secret },
          body: JSON.stringify({ email, password: `WrongPass${Math.random()}` }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, { email: STARTER.email, secret: E2E_SECRET });
      if (lastBody.status === 423) break;
    }

    expect(lastBody.status, 'the account should lock after repeated failures').toBe(423);
    expect(lastBody.body.error.code).toBe('ACCOUNT_LOCKED');

    // Even the CORRECT password is refused while locked — that is the point.
    const correct = await page.evaluate(async ({ email, password, secret }) => {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-E2E-Secret': secret },
        body: JSON.stringify({ email, password }),
      });
      return res.status;
    }, { email: STARTER.email, password: STARTER.chosen, secret: E2E_SECRET });
    expect(correct).toBe(423);
  });

  test('an unknown account does not reveal that it is unknown', async ({ page }) => {
    await page.goto('/');
    await logout(page);

    const unknown = await page.evaluate(async ({ secret }) => {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-E2E-Secret': secret },
        body: JSON.stringify({ email: 'nobody.at.all@example.com', password: 'WhateverPass123' }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, { secret: E2E_SECRET });

    expect(unknown.status).toBe(401);
    expect(JSON.stringify(unknown.body)).not.toMatch(/not found|no such user|unknown account/i);
  });
});

test.describe('session hygiene', () => {
  test('signing out ends the session for the API too', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'hr');
    expect((await apiAs(page, 'GET', '/employees')).status).toBe(200);

    await page.getByRole('button', { name: /sign out/i }).first().click();
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });

    // The refresh cookie is gone, so there is nothing left to exchange.
    const after = await apiAs(page, 'GET', '/employees');
    expect([401, 403]).toContain(after.status);
  });

  test('an admin can revoke the starter account, and it stops working', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'admin');

    const patched = await apiAs(page, 'PATCH', `/users/${starterUserId}`, { active: false });
    expect(patched.status).toBe(200);

    await signIn(page, STARTER.email, STARTER.chosen);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
  });

  test('the seeded accounts are untouched by all of this', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'hr');
    const res = await apiAs(page, 'GET', '/employees');
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.name === USERS.hr.name)).toBe(true);
    expect(PASSWORD).toBeTruthy();
  });
});
