import { expect } from '@playwright/test';
import { USERS, PASSWORD } from './harness.js';

/**
 * Shared browser actions. These drive the REAL UI — the same inputs and
 * buttons a person clicks — rather than calling the API directly, which is
 * the whole point of these specs.
 */

export async function login(page, who) {
  const user = USERS[who];
  if (!user) throw new Error(`Unknown E2E user "${who}"`);

  await page.goto('/');
  // The app may already hold a session from a previous spec.
  const emailInput = page.locator('input[type="email"]');
  if (!(await emailInput.isVisible().catch(() => false))) {
    await logout(page);
    await page.goto('/');
  }

  await emailInput.fill(user.email);
  await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // A successful password sign-in lands straight on the app shell.
  await expect(page.locator('input[type="email"]')).toBeHidden({ timeout: 20_000 });
  return user;
}

export async function logout(page) {
  // Prefer the REAL sign-out, which also revokes the refresh token server-side.
  const signOut = page.getByRole('button', { name: /sign out/i }).first();
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click().catch(() => {});
  }

  // Then make sure the session is actually gone. Clearing cookies once is not
  // enough on its own: the app refreshes its access token in the background,
  // and an in-flight /auth/refresh landing just after clearCookies() re-sets
  // the session cookie, leaving the next spec signed in as the previous user.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* blocked */ }
    }).catch(() => {});
    await page.context().clearCookies();
    await page.goto('/');
    const loginVisible = await page.locator('input[type="email"]')
      .isVisible({ timeout: 5_000 }).catch(() => false);
    if (loginVisible) return;
  }
  throw new Error('Could not return the browser to a signed-out state.');
}

/** Navigates using the app's own router, then waits for the route to settle. */
export async function goTo(page, path) {
  await page.goto(`/#${path}`.replace('/#/', '/'));
  await page.waitForLoadState('networkidle');
}

/**
 * Reads what the browser actually received from an API call, so a spec can
 * assert on the real response the UI was given rather than re-fetching.
 */
export async function captureResponse(page, urlFragment, action) {
  const waiter = page.waitForResponse(
    (res) => res.url().includes(urlFragment),
    { timeout: 20_000 },
  );
  await action();
  return waiter;
}
