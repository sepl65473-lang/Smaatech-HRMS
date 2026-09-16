import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';

/**
 * EMPLOYMENT LIFECYCLE through the real UI: the employment policy HR
 * configures, the confirmation queue it produces, and the confirm / promote /
 * transfer / salary-revision actions on an employee's profile.
 *
 * These changes used to be made by editing the profile form, which overwrote
 * the previous value with no effective date and no record. The assertions here
 * are as much about the HISTORY as the change.
 *
 * Runs after offboarding, so it creates its own subject rather than using the
 * seeded employee (who has been exited by then).
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const RUN = Date.now().toString().slice(-6);
const SUBJECT = {
  name: `E2E Lifecycle ${RUN}`,
  role: 'Associate Engineer',
  email: `e2e.lifecycle.${RUN}@example.com`,
};

let subjectId = null;

const dialog = (page) => page.locator('.modal[role="dialog"]');
const fieldInput = (scope, label) =>
  scope.locator(`.field:has(> .field-label:text-is("${label}"))`).locator('input, select').first();

async function openAs(page, who, linkName) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  if (linkName) await page.getByRole('link', { name: linkName }).first().click();
}

async function openEmploymentTab(page) {
  await page.goto(`/employees/${subjectId}`);
  await page.getByRole('button', { name: 'Employment', exact: true }).click();
  await expect(page.locator('.card-title', { hasText: 'Employment status' })).toBeVisible({ timeout: 20_000 });
}

test.describe('the employment policy is configured, not assumed', () => {
  test('the policy starts UNCONFIRMED and says so', async ({ page }) => {
    await openAs(page, 'admin', /settings/i);
    const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Employment policy' }) });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(/not yet confirmed/i);

    const policy = await apiAs(page, 'GET', '/lifecycle/policy');
    expect(policy.body.confirmedByHR).toBe(false);
  });

  test('an admin sets probation, notice and overtime from the UI', async ({ page }) => {
    await openAs(page, 'admin', /settings/i);
    const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Employment policy' }) });

    await card.locator('#policy-probationMonths').fill('3');
    await card.locator('#policy-noticePeriodDays').fill('45');
    await card.locator('#policy-overtimeMultiplier').fill('2');
    await card.locator('#policy-monthlyWorkingDays').fill('25');
    await card.locator('#policy-dailyWorkHours').fill('8');

    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/lifecycle/policy') && r.request().method() === 'PUT',
      { timeout: 30_000 },
    );
    await card.getByRole('button', { name: /Save employment policy/i }).click();
    expect((await saved).status()).toBe(200);

    const policy = await apiAs(page, 'GET', '/lifecycle/policy');
    expect(policy.body.probationMonths).toBe(3);
    expect(policy.body.noticePeriodDays).toBe(45);
    expect(policy.body.confirmedByHR).toBe(true);
  });

  test('a non-admin cannot change it', async ({ page }) => {
    await openAs(page, 'hr');
    const res = await apiAs(page, 'PUT', '/lifecycle/policy', { probationMonths: 24 });
    expect(res.status).toBe(403);
  });
});

test.describe('a new hire starts on probation, from the configured policy', () => {
  test('creating an employee sets a probation end date', async ({ page }) => {
    await openAs(page, 'admin', /employees/i);
    await page.getByRole('button', { name: 'Add employee', exact: true }).click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await fieldInput(modal, 'Full name').fill(SUBJECT.name);
    await fieldInput(modal, 'Role').fill(SUBJECT.role);
    await fieldInput(modal, 'Email').fill(SUBJECT.email);
    await fieldInput(modal, 'Monthly gross (₹)').fill('100000');
    await fieldInput(modal, 'Joining date').fill('2026-01-15');

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/employees') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await modal.getByRole('button', { name: 'Add employee', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);

    const body = await response.json();
    subjectId = body.id;
    expect(body.employmentStage).toBe('Probation');
    // 3-month probation, as configured above — not a number baked into the code.
    expect(body.probationEndDate).toBe('2026-04-15');
  });

  test('the hire appears in the confirmation queue as overdue', async ({ page }) => {
    await openAs(page, 'admin', /employees/i);
    const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Confirmation due' }) });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(SUBJECT.name);
    await expect(card).toContainText('overdue');
  });

  test('the profile shows the probation state and its history', async ({ page }) => {
    await openAs(page, 'admin');
    await openEmploymentTab(page);
    await expect(page.locator('.card-sub', { hasText: 'Probation' }).first()).toBeVisible();
    // Hiring is itself the first recorded lifecycle event.
    await expect(page.locator('.table')).toContainText('Probation started');
  });
});

test.describe('confirmation', () => {
  test('HR confirms the employee through the UI', async ({ page }) => {
    await openAs(page, 'admin');
    await openEmploymentTab(page);

    await page.getByRole('button', { name: 'Confirm employment' }).click();
    const form = page.locator('.form-grid').first();
    await form.locator('input[type="date"]').fill('2026-04-16');

    const confirmed = page.waitForResponse(
      (r) => r.url().includes(`/lifecycle/${subjectId}/confirm`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Record change' }).click();
    expect((await confirmed).status()).toBe(201);

    // The employee document moved, and the history records both sides.
    const employees = await apiAs(page, 'GET', '/employees');
    const subject = employees.body.find((e) => e.id === subjectId);
    expect(subject.employmentStage).toBe('Confirmed');
    expect(subject.confirmationDate).toBe('2026-04-16');

    const events = await apiAs(page, 'GET', `/lifecycle/events?empId=${subjectId}`);
    const confirmEvent = events.body.find((e) => e.type === 'confirmed');
    expect(confirmEvent.changes.employmentStage).toEqual({ from: 'Probation', to: 'Confirmed' });
    expect(confirmEvent.actor.name).toBeTruthy();
  });

  test('a confirmed employee leaves the confirmation queue', async ({ page }) => {
    await openAs(page, 'admin', /employees/i);
    const due = await apiAs(page, 'GET', '/lifecycle/probation/due?withinDays=30');
    expect(due.body.due.some((d) => d.id === subjectId)).toBe(false);
  });

  test('the same person cannot be confirmed twice', async ({ page }) => {
    await openAs(page, 'admin');
    const res = await apiAs(page, 'POST', `/lifecycle/${subjectId}/confirm`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
  });
});

test.describe('promotion, transfer and salary revision', () => {
  test('a promotion with a raise is recorded as one event', async ({ page }) => {
    await openAs(page, 'admin');
    await openEmploymentTab(page);

    await page.getByRole('button', { name: 'Promote' }).click();
    const form = page.locator('.form-grid').first();
    await fieldInput(form, 'New designation').fill('Engineer II');
    await fieldInput(form, 'New monthly gross (optional)').fill('125000');

    const promoted = page.waitForResponse(
      (r) => r.url().includes(`/lifecycle/${subjectId}/promote`), { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Record change' }).click();
    expect((await promoted).status()).toBe(201);

    const events = await apiAs(page, 'GET', `/lifecycle/events?empId=${subjectId}&type=promoted`);
    expect(events.body[0].changes.role).toEqual({ from: SUBJECT.role, to: 'Engineer II' });
    expect(events.body[0].changes.salary.to).toBe(125000);

    // And it is on screen, showing what it moved FROM.
    await expect(page.locator('.table')).toContainText('Promoted', { timeout: 15_000 });
  });

  test('a transfer moves department and reporting line', async ({ page }) => {
    await openAs(page, 'admin');
    await openEmploymentTab(page);

    await page.getByRole('button', { name: 'Transfer' }).click();
    const form = page.locator('.form-grid').first();
    await fieldInput(form, 'Department').fill('Platform');
    await fieldInput(form, 'Location').fill('Pune');

    const transferred = page.waitForResponse(
      (r) => r.url().includes(`/lifecycle/${subjectId}/transfer`), { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Record change' }).click();
    expect((await transferred).status()).toBe(201);

    const employees = await apiAs(page, 'GET', '/employees');
    const subject = employees.body.find((e) => e.id === subjectId);
    expect(subject.dept).toBe('Platform');
    expect(subject.loc).toBe('Pune');
  });

  test('a salary revision keeps the previous figure in the record', async ({ page }) => {
    await openAs(page, 'admin');
    await openEmploymentTab(page);

    await page.getByRole('button', { name: 'Revise salary' }).click();
    const form = page.locator('.form-grid').first();
    await fieldInput(form, 'New monthly gross').fill('135000');

    const revised = page.waitForResponse(
      (r) => r.url().includes(`/lifecycle/${subjectId}/salary-revision`), { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Record change' }).click();
    expect((await revised).status()).toBe(201);

    const events = await apiAs(page, 'GET', `/lifecycle/events?empId=${subjectId}&type=salary-revised`);
    expect(events.body[0].changes.salary).toEqual({ from: 125000, to: 135000 });
  });

  test('a pay CUT is refused without a reason', async ({ page }) => {
    await openAs(page, 'admin');
    const res = await apiAs(page, 'POST', `/lifecycle/${subjectId}/salary-revision`, { salary: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');

    const employees = await apiAs(page, 'GET', '/employees');
    expect(employees.body.find((e) => e.id === subjectId).salary).toBe(135000);
  });
});

test.describe('who may change employment', () => {
  test('an ordinary employee is refused every lifecycle write', async ({ page }) => {
    await openAs(page, 'manager');
    for (const [path, body] of [
      ['confirm', {}],
      ['promote', { role: 'Director' }],
      ['transfer', { dept: 'Board' }],
      ['salary-revision', { salary: 900000 }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiAs(page, 'POST', `/lifecycle/${subjectId}/${path}`, body);
      expect(res.status, `${path} was allowed`).toBe(403);
    }
  });

  test('an employee can read their OWN history and not another persons', async ({ page }) => {
    await openAs(page, 'manager');
    const own = await apiAs(page, 'GET', '/lifecycle/events');
    expect(own.status).toBe(200);

    const other = await apiAs(page, 'GET', `/lifecycle/events?empId=${subjectId}`);
    expect(other.status).toBe(403);
  });
});
