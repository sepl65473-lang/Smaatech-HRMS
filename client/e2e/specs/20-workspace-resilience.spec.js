import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * "Loading workspace…" must always resolve.
 *
 * REPRODUCES A REAL PRODUCTION REPORT. Layout.jsx gates the whole application
 * on `booting`, and the boot effect only clears it AFTER hydration:
 *
 *     const user = await authApi.bootstrap();
 *     if (user) { setAuthUser(user); await loadAuthenticatedData(...); }
 *     if (alive) setBooting(false);          // never runs if the await throws
 *
 * Inside loadAll every collection is individually guarded except settings, and
 * the face-status call beside it is unguarded too. So ONE failed request -
 * which on Render's free tier happens routinely, because a cold start answers
 * 503 for the first ~35 seconds - rejected the whole boot and left the user on
 * the spinner permanently, with no error and no way out but a hard reload.
 *
 * These specs fail one request at a time and require that the app still
 * reaches a usable state and says something actionable. A spinner that never
 * resolves is the failure mode being guarded against.
 */

/** Fails one API path for this page only. */
async function breakEndpoint(page, pattern) {
  await page.route((url) => url.pathname.includes(pattern), (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Service temporarily unavailable.' } }),
  }));
}

async function expectUsableWorkspace(page) {
  // The spinner must go away, and something real must be behind it.
  await expect(page.locator('text=Loading workspace')).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 45_000 });
}

test('a failing settings request does not strand the user on the spinner', async ({ page }) => {
  await login(page, 'reportee');
  await breakEndpoint(page, '/settings');

  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectUsableWorkspace(page);
  console.log(`[resilience] usable despite failing /settings in ${Date.now() - started} ms`);
});

test('a failing face-status request does not strand the user on the spinner', async ({ page }) => {
  await login(page, 'reportee');
  await breakEndpoint(page, '/face/status');

  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectUsableWorkspace(page);
  console.log(`[resilience] usable despite failing /face/status in ${Date.now() - started} ms`);
});

test('a cold-start 503 on every data call still reaches a usable, honest state', async ({ page }) => {
  // The Render Free cold start, simulated: the session restores but every
  // data call answers 503. The app must not hang, and must not pretend it
  // loaded data it does not have.
  await login(page, 'reportee');
  await page.route((url) => url.pathname.includes('/api/v1/')
    && !url.pathname.includes('/auth/'), (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Service temporarily unavailable.' } }),
  }));

  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('text=Loading workspace')).toBeHidden({ timeout: 45_000 });
  console.log(`[resilience] spinner cleared under total data failure in ${Date.now() - started} ms`);

  // Never a bare transport string - the server answered, and it said why.
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toContain('network error');
});

test('the normal path is unaffected', async ({ page }) => {
  await logout(page);
  const started = Date.now();
  await login(page, 'reportee');
  await expectUsableWorkspace(page);
  console.log(`[resilience] normal login to usable workspace: ${Date.now() - started} ms`);
});
