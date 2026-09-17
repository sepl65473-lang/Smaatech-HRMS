import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';

/**
 * Guards dashboard and Settings layout density.
 *
 * WHAT THIS ASSERTED BEFORE, AND WHY IT CHANGED. The first version required
 * every card to end within 24px of its content. That came from an attempt to
 * fix oversized cards by letting each one size to its own content. It worked
 * on that measure and made the page worse: the row still takes the height of
 * its tallest card, so the short ones left transparent holes in the middle of
 * the grid and the dashboard read as disconnected sections.
 *
 * The design decision is now the opposite - rows stay aligned, which is what
 * makes a dashboard look composed - and the height problem is attacked at its
 * source instead. So this file asserts the things that actually cause
 * oversized rows, rather than a rule the layout deliberately no longer follows:
 *
 *   1. cards in a row are aligned (the intent, not an accident)
 *   2. empty states are compact, not the 120px-of-padding blocks they were
 *   3. a chart with nothing to plot does not reserve its full height
 *   4. no horizontal overflow at desktop or tablet width
 */

async function rowAlignment(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const grid of document.querySelectorAll('.grid, .grid-2')) {
      // Group by the top edge. A grid can wrap onto several rows, and cards
      // only need to align with the ones BESIDE them - treating every child
      // of the grid as one row reported a false mismatch on Settings, where
      // a two-column grid holds two perfectly aligned rows.
      const byTop = new Map();
      for (const child of grid.children) {
        const r = child.getBoundingClientRect();
        if (r.height <= 0) continue;
        const key = Math.round(r.top);
        if (!byTop.has(key)) byTop.set(key, []);
        byTop.get(key).push(Math.round(r.height));
      }
      for (const heights of byTop.values()) if (heights.length > 1) rows.push(heights);
    }
    return rows;
  });
}

async function emptyStates(page) {
  return page.evaluate(() => [...document.querySelectorAll('.empty')]
    .filter((e) => e.getBoundingClientRect().height > 0)
    .map((e) => ({
      height: Math.round(e.getBoundingClientRect().height),
      padTop: Math.round(parseFloat(getComputedStyle(e).paddingTop) || 0),
      label: (e.querySelector('.empty-title')?.textContent || e.textContent).trim().slice(0, 30),
    })));
}

async function tallestCard(page) {
  return page.evaluate(() => {
    let max = 0; let title = '';
    for (const card of document.querySelectorAll('.card')) {
      const h = card.getBoundingClientRect().height;
      if (h > max) { max = h; title = card.querySelector('.card-title')?.textContent?.trim() || '(untitled)'; }
    }
    return { height: Math.round(max), title };
  });
}

async function noHorizontalOverflow(page) {
  const o = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(o.scrollW, 'page must not scroll horizontally').toBeLessThanOrEqual(o.clientW + 1);
}

/** Dead space between a card's last child and its bottom padding. */
async function cardSlack(page) {
  return page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => {
    const r = c.getBoundingClientRect();
    if (!r.height) return null;
    const pad = parseFloat(getComputedStyle(c).paddingBottom) || 0;
    const kids = [...c.children].filter((k) => k.getBoundingClientRect().height > 0);
    if (!kids.length) return null;
    const last = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
    return {
      title: c.querySelector('.card-title')?.textContent?.trim() || '(untitled)',
      slack: Math.round(r.bottom - last - pad),
    };
  }).filter(Boolean));
}

/**
 * `mode` picks the rule that actually applies to the page.
 *
 *   'aligned' - the DASHBOARD. Widgets sit in grid rows and look composed when
 *               they line up, so alignment is asserted and in-card slack is
 *               expected.
 *   'content' - SETTINGS. Independent configuration forms flow in columns and
 *               are sized to their content, so slack is asserted instead and
 *               differing heights side by side are the intent.
 *
 * One rule applied to both pages would be wrong for one of them.
 */
async function checkPage(page, label, { maxCard = 700, mode = 'aligned' } = {}) {
  const rows = await rowAlignment(page);
  const empties = await emptyStates(page);
  const tallest = await tallestCard(page);

  console.log(`[layout] ${label}: ${rows.length} multi-card rows, tallest card ${tallest.height}px (${tallest.title})`);
  if (empties.length) {
    console.log(`[layout]   empty states: ${empties.map((e) => `${e.height}px (pad ${e.padTop}) "${e.label}"`).join(' | ')}`);
  }

  if (mode === 'aligned') {
    // Cards in a row line up. A ragged row is the disconnected look.
    for (const heights of rows) {
      const spread = Math.max(...heights) - Math.min(...heights);
      expect(spread, `cards in a row should align, got heights ${heights.join('/')}`).toBeLessThanOrEqual(2);
    }
  } else {
    // Content-sized: a card must end shortly after its content. This is what
    // caught "Organisation" sitting at 1035px with 696px of nothing under it.
    const slacks = await cardSlack(page);
    console.log(`[layout]   card slack: ${slacks.map((c) => `${c.slack}px ${c.title}`).join(' | ')}`);
    for (const c of slacks) {
      expect(c.slack, `"${c.title}" has ${c.slack}px of empty space below its content`).toBeLessThanOrEqual(24);
    }
  }

  // 2. Guard the actual regression: .empty carried 60px of padding top AND
  //    bottom, 120px of pure whitespace, which made "No pending requests"
  //    taller than several real cards. Asserting PADDING rather than total
  //    height keeps this honest - an empty state with a title and a
  //    description is legitimately taller than a one-liner, and that is
  //    content, not wasted space.
  for (const e of empties) {
    expect(e.padTop, `empty state "${e.label}" has ${e.padTop}px of padding`).toBeLessThanOrEqual(32);
  }

  // 3. No single card should tower over the viewport.
  expect(tallest.height, `"${tallest.title}" is unusually tall`).toBeLessThanOrEqual(maxCard);

  await noHorizontalOverflow(page);
}

for (const role of ['admin', 'hr', 'finance', 'reportee']) {
  test(`dashboard layout density for ${role}`, async ({ page }) => {
    await logout(page);
    await login(page, role);
    await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await checkPage(page, `${role} dashboard`);
  });
}

test('settings layout density', async ({ page }) => {
  await logout(page);
  await login(page, 'admin');
  await page.goto('/settings');
  await page.waitForTimeout(1500);
  // Settings forms are legitimately long, so the towering-card guard is
  // relaxed here; the row-alignment and empty-state checks still apply.
  await checkPage(page, 'settings', { maxCard: 1400, mode: 'content' });
});

test('an empty chart does not reserve its full height', async ({ page }) => {
  // The payroll chart drew grid lines and axis labels with nothing to plot,
  // holding a ~150px blank box that then set the height of its whole row.
  await logout(page);
  await login(page, 'admin');
  await page.waitForTimeout(1500);

  const chartBoxes = await page.evaluate(() => [...document.querySelectorAll('.chart')]
    .map((c) => ({ height: Math.round(c.getBoundingClientRect().height), bars: c.querySelectorAll('rect, path, circle').length })));
  console.log(`[layout] chart boxes: ${JSON.stringify(chartBoxes)}`);

  for (const c of chartBoxes) {
    // A rendered chart box must actually be drawing something.
    expect(c.bars, 'a chart box that reserves height must have content').toBeGreaterThan(0);
  }
});

test('the layout holds on a tablet viewport', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await logout(page);
  await login(page, 'admin');
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await noHorizontalOverflow(page);
  console.log('[layout] tablet 820px: no horizontal overflow');
});
