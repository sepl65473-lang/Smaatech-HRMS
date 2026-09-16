import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * FRONTEND HEALTH: every page each role can reach, opened for real.
 *
 * What this catches that a build never does — a route that renders nothing, a
 * component that throws on mount, a failed request behind a page that looks
 * fine, and text that says "Loading…" for ever. The pages are discovered from
 * the signed-in navigation rather than listed here, so a new page is covered
 * the day it is added.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

// Noise that is not a defect: a request the app deliberately allows to fail
// (a role that may not read a collection), and the dev-server's own chatter.
const IGNORABLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource: the server responded with a status of 40[13]/i,
  /favicon/i,
  // Artefacts of this HARNESS, not of the application: Playwright attaches the
  // X-E2E-Secret header to every request the page makes, including the
  // cross-origin webfont fetches, which then fail their CORS preflight. No such
  // header exists in production and the fonts load normally there.
  /fonts\.(gstatic|googleapis)\.com/i,
  /net::ERR_FAILED/i,
  /React Router Future Flag Warning/i,
];

function watch(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORABLE.some((pattern) => pattern.test(text))) return;
    problems.push(`console: ${text}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  return problems;
}

async function navLinks(page) {
  return page.locator('aside a[href], nav a[href]').evaluateAll((links) => (
    [...new Set(links.map((a) => a.getAttribute('href')))]
      .filter((href) => href && href.startsWith('/') && !href.startsWith('//'))
  ));
}

for (const who of ['admin', 'hr', 'manager', 'finance']) {
  test(`every page ${who} can reach renders without errors`, async ({ page }) => {
    const problems = watch(page);

    await page.goto('/');
    await logout(page);
    await login(page, who);

    const routes = await navLinks(page);
    expect(routes.length, `${who} should have navigation`).toBeGreaterThan(0);

    const broken = [];
    for (const route of routes) {
      // eslint-disable-next-line no-await-in-loop
      await page.goto(route);
      // eslint-disable-next-line no-await-in-loop
      await page.waitForLoadState('networkidle').catch(() => {});

      // eslint-disable-next-line no-await-in-loop
      const body = (await page.locator('main').innerText().catch(() => '')).trim();

      if (!body) {
        broken.push(`${route}: rendered nothing`);
      } else if (/^Loading[….]*$/i.test(body)) {
        // A page still saying "Loading…" after the network went quiet is stuck.
        broken.push(`${route}: still loading after the network settled`);
      }
    }

    expect(broken, `${who} hit broken pages`).toEqual([]);
    expect(problems, `${who} saw console errors`).toEqual([]);
  });
}

test('a route a role may not use says so, rather than failing', async ({ page }) => {
  const problems = watch(page);

  await page.goto('/');
  await logout(page);
  await login(page, 'manager');

  // Straight to an admin-only area by URL, the way someone with a bookmark
  // or a shared link arrives.
  await page.goto('/settings');
  await page.waitForLoadState('networkidle').catch(() => {});

  await expect(page.locator('main')).toContainText(/Access restricted|do not have access|not have access/i, {
    timeout: 20_000,
  });
  expect(problems).toEqual([]);
});

test('an unknown route does not break the application', async ({ page }) => {
  const problems = watch(page);

  await page.goto('/');
  await logout(page);
  await login(page, 'admin');

  await page.goto('/this-route-does-not-exist');
  await page.waitForLoadState('networkidle').catch(() => {});

  // Whatever it shows, the shell must survive and navigation must still work.
  await expect(page.locator('aside, nav').first()).toBeVisible({ timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('main')).not.toBeEmpty();
  expect(problems).toEqual([]);
});
