import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * MEASURES wasted vertical space in cards, so layout work is driven by numbers
 * rather than by eye.
 *
 * For every card it reports the rendered height against the bottom of its last
 * child. The difference, minus the card's own bottom padding, is dead space -
 * which is what "the card is too tall and empty underneath" actually means.
 *
 * The suspected cause is CSS Grid's default `align-items: stretch`: a short
 * card sharing a row with a taller sibling is stretched to match it, leaving a
 * gap under its content. index.css already half-acknowledges this with the
 * `.card.row-fill` opt-in "for a card sharing a grid row with a taller
 * sibling".
 */

async function measureCards(page, label) {
  const cards = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.card')) {
      const rect = card.getBoundingClientRect();
      if (rect.height === 0) continue;
      const style = getComputedStyle(card);
      const padBottom = parseFloat(style.paddingBottom) || 0;
      const kids = [...card.children].filter((k) => k.getBoundingClientRect().height > 0);
      if (!kids.length) continue;
      const lastBottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
      const slack = Math.round(rect.bottom - lastBottom - padBottom);
      const title = card.querySelector('.card-title')?.textContent?.trim() || '(untitled)';
      out.push({ title, height: Math.round(rect.height), slack });
    }
    return out;
  });

  const wasteful = cards.filter((c) => c.slack > 24);
  console.log(`[layout] ${label}: ${cards.length} cards, ${wasteful.length} with dead space > 24px`);
  for (const c of cards) {
    const flag = c.slack > 24 ? '  <-- DEAD SPACE' : '';
    console.log(`[layout]   ${String(c.height).padStart(4)}px  slack ${String(c.slack).padStart(4)}px  ${c.title}${flag}`);
  }
  return { cards, wasteful };
}

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return { scrollW: d.scrollWidth, clientW: d.clientWidth };
  });
  expect(overflow.scrollW, 'page must not scroll horizontally').toBeLessThanOrEqual(overflow.clientW + 1);
}

const ROLES = ['admin', 'hr', 'finance', 'reportee'];

for (const role of ROLES) {
  test(`dashboard card density for ${role}`, async ({ page }) => {
    await logout(page);
    await login(page, role);
    await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);

    const { wasteful } = await measureCards(page, `${role} dashboard`);
    await noHorizontalOverflow(page);

    // No card may be stretched far beyond what its content needs.
    for (const c of wasteful) {
      expect(c.slack, `"${c.title}" has ${c.slack}px of empty space below its content`).toBeLessThanOrEqual(24);
    }
  });
}

test('settings card density', async ({ page }) => {
  await logout(page);
  await login(page, 'admin');
  await page.goto('/settings');
  await page.waitForTimeout(1500);

  const { wasteful } = await measureCards(page, 'settings');
  await noHorizontalOverflow(page);

  for (const c of wasteful) {
    expect(c.slack, `"${c.title}" has ${c.slack}px of empty space below its content`).toBeLessThanOrEqual(24);
  }
});

test('the compact layout holds on a tablet viewport', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await logout(page);
  await login(page, 'admin');
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);

  await measureCards(page, 'admin dashboard @820px');
  await noHorizontalOverflow(page);
});
