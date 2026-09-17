import { test } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * Captures full-page screenshots of every dashboard and Settings so layout work
 * is judged by looking at the rendered result, not by reading CSS.
 *
 * Not an assertion suite - it produces images for inspection. Kept out of the
 * assertion specs deliberately so it never fails a run on its own.
 */
const SHOTS = [
  ['admin', '/'],
  ['hr', '/'],
  ['finance', '/'],
  ['reportee', '/'],
];

for (const [role, path] of SHOTS) {
  test(`screenshot ${role} dashboard`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await logout(page);
    await login(page, role);
    await page.goto(path);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `layout-shots/${role}-dashboard.png`, fullPage: true });
  });
}

test('screenshot settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await logout(page);
  await login(page, 'admin');
  await page.goto('/settings');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'layout-shots/settings.png', fullPage: true });
});
