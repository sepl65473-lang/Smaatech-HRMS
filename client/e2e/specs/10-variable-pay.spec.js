import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * VARIABLE PAY through the real UI: overtime, bonus and ad-hoc deductions
 * raised against a cycle, approved by Finance, and folded into the payroll run.
 *
 * Payroll could previously only pay a fixed gross minus statutory deductions
 * and loss of pay, so none of this could be paid through the system.
 *
 * The two properties worth driving through a browser: the amount for overtime
 * is the SERVER's, computed from salary and the configured multiplier, and an
 * unapproved item is not paid.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

// A cycle of its own, so this never collides with the payroll spec's run.
const CYCLE = '2026-11';
let subjectId = null;
let bonusId = null;

async function openPayroll(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /payroll/i }).first().click();
  await expect(page.locator('.card-title', { hasText: 'Payroll register' })).toBeVisible({ timeout: 20_000 });
}

const variablePayCard = (page) =>
  page.locator('.card', { has: page.locator('.card-title', { hasText: 'Variable pay' }) });

test.describe('raising variable pay', () => {
  test('overtime is valued by the SERVER, not by the claim', async ({ page }) => {
    await openPayroll(page, 'admin');

    // The manager is the subject: the seeded employee has been exited by the
    // offboarding spec.
    const employees = await apiAs(page, 'GET', '/employees');
    const subject = employees.body.find((e) => e.name === USERS.manager.name);
    subjectId = subject.id;

    // Fix the working pattern so the expected figure is arithmetic, not a guess.
    const policy = await apiAs(page, 'PUT', '/lifecycle/policy', {
      monthlyWorkingDays: 25, dailyWorkHours: 8, overtimeMultiplier: 2, overtimeRequiresApproval: true,
    });
    expect(policy.status).toBe(200);

    const res = await apiAs(page, 'POST', '/pay-components', {
      empId: subjectId, cycle: CYCLE, kind: 'overtime', hours: 10, amount: 9999999,
    });
    expect(res.status).toBe(201);

    // 200,000 / (25 * 8) = 1000/hour, at 2x for 10 hours = 20,000 — and the
    // amount sent with the claim is ignored entirely.
    expect(res.body.hourlyRate).toBe(1000);
    expect(res.body.amount).toBe(20000);
    expect(res.body.status).toBe('pending');
  });

  test('a bonus is raised through the real form on the payroll page', async ({ page }) => {
    await openPayroll(page, 'admin');

    // Point the register at the cycle under test. Any month can be chosen —
    // a cycle with no payslips yet is exactly the one you need to prepare.
    await page.locator('#payroll-cycle').fill(CYCLE);

    const card = variablePayCard(page);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(CYCLE);

    await card.getByRole('button', { name: /Add variable pay/i }).click();
    await card.locator('#vp-employee').selectOption(subjectId);
    await card.locator('#vp-kind').selectOption('bonus');
    await card.locator('#vp-amount').fill('30000');
    await card.locator('#vp-description').fill('Festival bonus');

    const raised = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/pay-components') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await card.getByRole('button', { name: 'Raise', exact: true }).click();
    const response = await raised;
    expect(response.status()).toBe(201);

    const body = await response.json();
    bonusId = body.id;
    expect(body.amount).toBe(30000);
    expect(body.status).toBe('pending');

    // Visible in the table the person is looking at.
    await expect(card.locator('.table')).toContainText('Festival bonus', { timeout: 15_000 });
  });

  test('an HR Manager may raise variable pay too', async ({ page }) => {
    // HR has no payroll page in this tenant's role configuration, so this is
    // an API check from inside their real signed-in session.
    await page.goto('/');
    await logout(page);
    await login(page, 'hr');
    const res = await apiAs(page, 'POST', '/pay-components', {
      empId: subjectId, cycle: CYCLE, kind: 'reimbursement', amount: 1500, description: 'Travel claim',
    });
    expect(res.status).toBe(201);
  });

  test('an employee cannot raise pay for themselves', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');
    const res = await apiAs(page, 'POST', '/pay-components', {
      empId: subjectId, cycle: CYCLE, kind: 'bonus', amount: 100000,
    });
    expect(res.status).toBe(403);
  });

  test('an HR Manager cannot approve money — raising and approving must differ', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'hr');
    const res = await apiAs(page, 'POST', `/pay-components/${bonusId}/decision`, { decision: 'approved' });
    expect(res.status).toBe(403);
  });
});

test.describe('approval and payment', () => {
  test('Finance sees the cycle summary with pending money called out', async ({ page }) => {
    await openPayroll(page, 'finance');
    const summary = await apiAs(page, 'GET', `/pay-components/summary?cycle=${CYCLE}`);
    expect(summary.status).toBe(200);
    expect(summary.body.approvedEarnings).toBe(0);
    expect(summary.body.pendingTotal).toBe(51500); // 20,000 overtime + 30,000 bonus + 1,500 travel
    expect(summary.body.pendingCount).toBe(3);
  });

  test('Finance approves the bonus from the UI', async ({ page }) => {
    await openPayroll(page, 'finance');
    await page.locator('#payroll-cycle').fill(CYCLE);
    const card = variablePayCard(page);
    await expect(card).toBeVisible({ timeout: 20_000 });

    const row = card.locator('tr', { hasText: 'Festival bonus' });
    await expect(row).toBeVisible({ timeout: 20_000 });

    const decided = page.waitForResponse(
      (r) => r.url().includes(`/pay-components/${bonusId}/decision`), { timeout: 30_000 },
    );
    await row.getByRole('button', { name: 'Approve' }).click();
    expect((await decided).status()).toBe(200);

    const components = await apiAs(page, 'GET', `/pay-components?cycle=${CYCLE}`);
    expect(components.body.find((c) => c.id === bonusId).status).toBe('approved');
  });

  test('the payroll run pays the approved item and NOT the pending one', async ({ page }) => {
    await openPayroll(page, 'finance');

    const run = await apiAs(page, 'POST', '/payroll/run', { cycle: CYCLE });
    expect([200, 201]).toContain(run.status);
    expect(run.body.variablePayIncluded).toBe(30000);
    // The overtime nobody approved must be reported, not silently dropped.
    expect(run.body.pendingComponentsNotPaid).toBe(2);

    const payroll = await apiAs(page, 'GET', '/payroll');
    const row = payroll.body.find((p) => p.cycle === CYCLE && p.empId === subjectId);
    expect(row).toBeTruthy();
    // 200,000 contractual + 30,000 bonus.
    expect(row.gross).toBe(230000);
    // And it is a line of its own on the payslip, not folded invisibly in.
    expect(row.components.earnings.some((e) => e.amount === 30000)).toBe(true);
  });

  test('the payslip shows the variable pay to the person it belongs to', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'manager');
    const payroll = await apiAs(page, 'GET', '/payroll');
    const own = payroll.body.find((p) => p.cycle === CYCLE);
    expect(own).toBeTruthy();
    expect(own.components.earnings.some((e) => e.amount === 30000)).toBe(true);
  });

  test('an approved item is never paid twice', async ({ page }) => {
    await openPayroll(page, 'finance');
    const again = await apiAs(page, 'POST', '/payroll/run', { cycle: CYCLE });
    expect(again.body.created).toBe(0);

    const next = await apiAs(page, 'POST', '/payroll/run', { cycle: '2026-12' });
    expect(next.body.variablePayIncluded).toBe(0);
  });

  test('nothing can be added to a cycle once it is paid', async ({ page }) => {
    await openPayroll(page, 'finance');
    const payroll = await apiAs(page, 'GET', '/payroll');
    const row = payroll.body.find((p) => p.cycle === CYCLE && p.empId === subjectId);
    const paid = await apiAs(page, 'PATCH', `/payroll/${row.id}`, { status: 'paid' });
    expect(paid.status).toBe(200);

    const res = await apiAs(page, 'POST', '/pay-components', {
      empId: subjectId, cycle: CYCLE, kind: 'bonus', amount: 5000,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CYCLE_ALREADY_PAID');

    // Disbursement closes out the component it carried.
    const components = await apiAs(page, 'GET', `/pay-components?cycle=${CYCLE}`);
    expect(components.body.find((c) => c.id === bonusId).status).toBe('paid');
  });
});
