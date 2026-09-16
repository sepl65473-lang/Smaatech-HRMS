import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * MEASURES what a person actually waits for, in a real browser.
 *
 * The complaint this exists to answer was a long spinner on opening the app
 * and signing in, plus an unexplained "Network Error". Unit tests cannot see
 * any of that: it is navigation timing, request fan-out and hydration.
 *
 * These assertions are deliberately loose. They are regression guards against
 * a request storm or a spinner that never resolves, NOT performance targets -
 * absolute numbers on a laptop running an isolated stack are not production
 * numbers and should not be read as such. The measurements are printed so the
 * real figures are visible rather than hidden behind a pass/fail.
 *
 * Uses `reportee`, not `employee`: this spec runs after 07-offboarding, which
 * exits the `employee` account, so signing in as that one fails here for a
 * reason that has nothing to do with bootstrap performance.
 */

function track(page) {
  const requests = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) requests.push({ url: r.url(), method: r.method(), at: Date.now() });
  });
  const failures = [];
  page.on('requestfailed', (r) => {
    if (r.url().includes('/api/v1/')) failures.push({ url: r.url(), reason: r.failure()?.errorText });
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  return { requests, failures, consoleErrors };
}

const apiPath = (url) => url.split('/api/v1/')[1]?.split('?')[0] ?? url;

function duplicates(requests) {
  const seen = new Map();
  for (const r of requests) {
    const key = `${r.method} ${apiPath(r.url)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1);
}

test('the login page becomes usable without a request storm', async ({ page }) => {
  const seen = track(page);
  await logout(page);

  const started = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
  const usableMs = Date.now() - started;

  const nav = await page.evaluate(() => {
    const [e] = performance.getEntriesByType('navigation');
    return e ? { domContentLoaded: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd) } : null;
  });

  console.log(`[perf] login page usable in ${usableMs} ms`);
  console.log(`[perf] navigation timing: ${JSON.stringify(nav)}`);
  console.log(`[perf] API requests before sign-in: ${seen.requests.length} -> ${seen.requests.map((r) => apiPath(r.url)).join(', ') || '(none)'}`);
  console.log(`[perf] failed API requests: ${seen.failures.length} ${JSON.stringify(seen.failures)}`);

  // An unauthenticated login screen has no business fanning out to the API.
  expect(seen.requests.length).toBeLessThanOrEqual(3);
  expect(seen.failures).toHaveLength(0);
});

test('signing in reaches a usable shell and hydration does not duplicate requests', async ({ page }) => {
  const seen = track(page);
  await logout(page);
  await page.goto('/');
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });

  const before = seen.requests.length;
  const started = Date.now();
  await login(page, 'reportee');
  const shellMs = Date.now() - started;

  // The shell is usable when the spinner is gone and navigation is present.
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 20_000 });
  const dashboardMs = Date.now() - started;

  const hydration = seen.requests.slice(before);
  const dupes = duplicates(hydration);

  console.log(`[perf] sign-in to shell: ${shellMs} ms`);
  console.log(`[perf] sign-in to usable dashboard: ${dashboardMs} ms`);
  console.log(`[perf] hydration API requests: ${hydration.length}`);
  console.log(`[perf] hydration endpoints: ${hydration.map((r) => apiPath(r.url)).join(', ')}`);
  console.log(`[perf] repeated endpoints: ${dupes.length ? JSON.stringify(dupes) : 'none'}`);
  console.log(`[perf] failed API requests: ${seen.failures.length} ${JSON.stringify(seen.failures)}`);
  console.log(`[perf] console errors: ${seen.consoleErrors.length} ${JSON.stringify(seen.consoleErrors.slice(0, 3))}`);

  expect(seen.failures).toHaveLength(0);
  // Guard against a hydration storm. An ordinary employee should not be
  // fetching every collection in the product.
  expect(hydration.length).toBeLessThanOrEqual(20);
  // The same endpoint fetched repeatedly on one hydration is the duplicate
  // amplification this guards against.
  for (const [endpoint, count] of dupes) {
    expect(count, `${endpoint} was requested ${count} times during one hydration`).toBeLessThanOrEqual(2);
  }
});

test('a reload restores the session without stranding the user on a spinner', async ({ page }) => {
  const seen = track(page);
  await login(page, 'reportee');

  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 25_000 });
  const restoredMs = Date.now() - started;

  console.log(`[perf] reload to usable shell: ${restoredMs} ms`);
  console.log(`[perf] failed API requests on reload: ${seen.failures.length}`);

  // Still signed in: the login form must not come back.
  await expect(page.locator('input[type="email"]')).toBeHidden();
  expect(seen.failures).toHaveLength(0);
});
