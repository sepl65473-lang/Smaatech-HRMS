import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * Phone-width comfort, measured in the rendered page rather than read off the
 * CSS: nothing may make the page pan sideways, and the top-bar dropdowns must
 * open on the screen, not below its bottom edge.
 */
const PHONES = [[320, 568], [360, 640], [375, 667], [390, 844], [412, 915], [430, 932]];
const PAGES = ['/', '/ess', '/employees', '/attendance', '/leave', '/holidays', '/payroll', '/performance',
  '/analytics', '/settings', '/assets'];

const sidewaysOverflow = (page) => page.evaluate(
  () => document.documentElement.scrollWidth - window.innerWidth,
);

const boxOf = (page, selector) => page.locator(selector).first().boundingBox();

test('the sign-in screen fits every phone width', async ({ page }) => {
  await page.goto('/');
  await logout(page);
  for (const [width, height] of PHONES) {
    await page.setViewportSize({ width, height });
    expect(await sidewaysOverflow(page), `sign-in at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('no page pans sideways on a phone', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 667 });
  await logout(page);
  await login(page, 'admin');
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    for (const [width, height] of PHONES) {
      await page.setViewportSize({ width, height });
      expect(await sidewaysOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('top-bar dropdowns open on screen, under the top bar', async ({ page }) => {
  // Notifications exist only in this browser; nothing is written to the server.
  await page.route('**/api/v1/notifications*', (route) => (route.request().method() === 'GET'
    ? route.fulfill({
      json: Array.from({ length: 9 }, (_, i) => ({
        id: `n${i}`, title: `Leave request ${i + 1}`, message: 'Requested 2 days of casual leave',
        read: i > 3, createdAt: new Date().toISOString(), actionUrl: '/leave',
      })),
    })
    : route.continue()));

  await page.setViewportSize({ width: 375, height: 667 });
  await logout(page);
  await login(page, 'admin');

  for (const [width, height] of [[320, 568], [375, 667], [430, 932]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const onScreen = async (selector, what) => {
      const box = await boxOf(page, selector);
      expect(box, `${what} at ${width}px`).toBeTruthy();
      expect(box.x, `${what} left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${what} right edge at ${width}px`).toBeLessThanOrEqual(width);
      expect(box.y + box.height, `${what} bottom edge at ${width}px`).toBeLessThanOrEqual(height);
    };

    await page.getByTitle('Notifications').click();
    await onScreen('.notification-popover', 'notifications');

    await page.locator('.profile-chip').click();
    await onScreen('.profile-popover', 'profile menu');
    await expect(page.getByRole('button', { name: /sign out/i }).first()).toBeVisible();
    await page.locator('.profile-chip').click();

    await page.locator('.search').fill('e2e');
    await onScreen('.search-popover', 'search results');
    await page.locator('.search').fill('');
  }
});

test('the navigation drawer and a long dialog stay inside the screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await logout(page);
  await login(page, 'admin');

  await page.locator('.menu-btn').click();
  const drawer = page.locator('aside');
  await expect(drawer).toBeInViewport();
  const drawerBox = await drawer.boundingBox();
  expect(Math.round(drawerBox.y + drawerBox.height)).toBeLessThanOrEqual(568);
  // The last thing in the drawer can be scrolled to.
  await drawer.locator('.user-card').scrollIntoViewIfNeeded();
  await expect(drawer.locator('.user-card')).toBeInViewport();
  await page.locator('.mobile-scrim').click({ position: { x: 310, y: 300 } });

  await page.goto('/employees');
  await page.getByRole('button', { name: /add employee/i }).last().click();
  const actions = await boxOf(page, '.modal .modal-actions');
  expect(actions.y + actions.height).toBeLessThanOrEqual(568);
});

test('the employee check-in buttons are finger-sized on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await logout(page);
  await login(page, 'reportee');
  const qr = page.getByRole('button', { name: /scan office qr/i }).first();
  await expect(qr).toBeVisible({ timeout: 20_000 });
  expect((await qr.boundingBox()).height).toBeGreaterThanOrEqual(32);
});
