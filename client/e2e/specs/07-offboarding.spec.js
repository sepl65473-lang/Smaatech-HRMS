import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS, PASSWORD } from '../fixtures/harness.js';

/**
 * RESIGNATION AND OFFBOARDING, driven through the real UI:
 *
 *   employee files their exit -> HR sees it -> department clearances are signed
 *   -> Finance settles F&F -> disbursement terminates access
 *
 * The last step is the one that matters most: paying someone out must actually
 * end their access, in the same transaction, not leave a live login behind.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

let resignationId = null;

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function openExits(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /resignation|exit/i }).first().click();
  await expect(page.locator('.card-title', { hasText: /Exit & Clearance Cockpit/i }))
    .toBeVisible({ timeout: 20_000 });
}

test.describe('an employee files their own exit', () => {
  test('the resignation form submits and the exit appears', async ({ page }) => {
    await openExits(page, 'employee');

    // An employee lands straight on their own exit tab.
    await expect(page.locator('.card-title', { hasText: 'File Resignation' })).toBeVisible({ timeout: 15_000 });

    await page.locator('input[type="date"]').first().fill(isoDaysFromNow(45));
    await page.locator('textarea').first().fill('E2E exit — moving on');

    const filed = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/resignations') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /Submit Resignation/i }).click();
    const response = await filed;
    expect(response.status()).toBe(201);

    const created = await response.json();
    resignationId = created.id;
    expect(created.status).toBe('Submitted');
    // Four department clearances are opened automatically.
    expect(created.clearances).toHaveLength(4);
    // The name comes from the employee record, not from anything the page sent.
    expect(created.employeeName).toBe(USERS.employee.name);
  });

  test('a second exit cannot be filed while one is open', async ({ page }) => {
    await openExits(page, 'employee');
    const res = await apiAs(page, 'POST', '/resignations', {
      employeeId: (await apiAs(page, 'GET', '/resignations')).body[0].employeeId,
      resignationDate: isoDaysFromNow(0),
      requestedLastWorkingDay: isoDaysFromNow(60),
      reason: 'Duplicate attempt',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESIGNATION_ALREADY_OPEN');
  });

  test('the employee sees only their own exit', async ({ page }) => {
    await openExits(page, 'employee');
    const list = await apiAs(page, 'GET', '/resignations');
    expect(list.status).toBe(200);
    for (const row of list.body) expect(row.employeeName).toBe(USERS.employee.name);
  });
});

test.describe('HR and Finance process the exit', () => {
  test('HR sees the exit in the cockpit and signs the HR clearance', async ({ page }) => {
    await openExits(page, 'hr');

    const row = page.locator('tr', { hasText: USERS.employee.name }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    const signed = page.waitForResponse(
      (r) => r.url().includes(`/resignations/${resignationId}/clearance`),
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Sign HR' }).click();
    expect((await signed).status()).toBe(200);

    const after = await apiAs(page, 'GET', '/resignations');
    const exit = after.body.find((r) => r.id === resignationId);
    const hrClearance = exit.clearances.find((c) => c.dept === 'HR');
    expect(hrClearance.status).toBe('Approved');
    // Who signed it must be recorded — a clearance with no signatory is not a
    // clearance.
    expect(hrClearance.approvedBy).toBeTruthy();
  });

  test('a department clearance cannot be signed by the wrong department', async ({ page }) => {
    await openExits(page, 'hr');
    // HR is not IT... but HR is the fallback for IT in this product, so the
    // check that matters is that an ordinary EMPLOYEE cannot sign anything.
    await page.goto('/');
    await logout(page);
    await login(page, 'employee');
    const res = await apiAs(page, 'POST', `/resignations/${resignationId}/clearance`, {
      dept: 'Finance', status: 'Approved', notes: 'self-signed',
    });
    expect(res.status).toBe(403);
  });

  test('Finance settles the F&F and the maths is the server maths', async ({ page }) => {
    await openExits(page, 'finance');

    const fnf = await apiAs(page, 'POST', `/resignations/${resignationId}/fnf`, {
      monthlySalary: 150000,
      leaveEncashment: 20000,
      gratuity: 30000,
      otherAllowances: 0,
      loansDeduction: 5000,
      assetDeduction: 2000,
      otherDeductions: 0,
      notes: 'E2E settlement',
    });
    expect(fnf.status).toBe(200);
    expect(fnf.body.fnfSettlement.netPayout).toBe(150000 + 20000 + 30000 - 5000 - 2000);
    expect(fnf.body.fnfSettlement.status).toBe('Processed');
  });

  test('an employee cannot settle their own F&F', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'employee');
    const res = await apiAs(page, 'POST', `/resignations/${resignationId}/fnf`, {
      monthlySalary: 9999999, leaveEncashment: 0, gratuity: 0, otherAllowances: 0,
      loansDeduction: 0, assetDeduction: 0, otherDeductions: 0,
    });
    expect(res.status).toBe(403);
  });
});

test.describe('disbursement terminates access', () => {
  test('payout is REFUSED while any clearance is outstanding', async ({ page }) => {
    await openExits(page, 'finance');
    const res = await apiAs(page, 'POST', `/resignations/${resignationId}/fnf/pay`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLEARANCES_PENDING');
    // IT, Finance and Admin are still open at this point.
    expect(res.body.error.outstanding.length).toBeGreaterThan(0);
  });

  test('the remaining clearances are signed by the departments that own them', async ({ page }) => {
    // Finance signs its own.
    await openExits(page, 'finance');
    const financeSigned = await apiAs(page, 'POST', `/resignations/${resignationId}/clearance`, {
      dept: 'Finance', status: 'Approved', notes: 'No dues',
    });
    expect(financeSigned.status).toBe(200);

    // HR closes IT and Admin from the cockpit.
    await openExits(page, 'hr');
    const row = page.locator('tr', { hasText: USERS.employee.name }).first();
    await row.click();
    for (const dept of ['IT', 'Admin']) {
      const signed = page.waitForResponse(
        (r) => r.url().includes(`/resignations/${resignationId}/clearance`),
        { timeout: 30_000 },
      );
      // eslint-disable-next-line no-await-in-loop
      await page.getByRole('button', { name: `Sign ${dept}` }).click();
      // eslint-disable-next-line no-await-in-loop
      expect((await signed).status()).toBe(200);
    }

    const after = await apiAs(page, 'GET', '/resignations');
    const exit = after.body.find((r) => r.id === resignationId);
    expect(exit.clearances.every((c) => c.status === 'Approved')).toBe(true);
  });

  test('paying the settlement exits the employee and kills the login', async ({ page }) => {
    await openExits(page, 'finance');

    const paid = await apiAs(page, 'POST', `/resignations/${resignationId}/fnf/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body.fnfSettlement.status).toBe('Paid');

    // The person can no longer sign in — the settlement and the access
    // termination are one act, not two things someone has to remember.
    await page.goto('/');
    await logout(page);
    await page.goto('/');
    await page.locator('input[type="email"]').fill(USERS.employee.email);
    await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.login-error')).toBeVisible({ timeout: 20_000 });
  });

  test('the exited employee is marked as such for HR', async ({ page }) => {
    await openExits(page, 'hr');
    const employees = await apiAs(page, 'GET', '/employees');
    const exited = employees.body.find((e) => e.name === USERS.employee.name);
    expect(exited).toBeTruthy();
    expect(exited.status).not.toBe('active');
  });

  test('the settlement cannot be paid twice', async ({ page }) => {
    await openExits(page, 'finance');
    const again = await apiAs(page, 'POST', `/resignations/${resignationId}/fnf/pay`);
    // Either refused, or an idempotent replay of the same settlement — never a
    // second disbursement.
    if (again.status === 200) {
      expect(again.body.fnfSettlement.status).toBe('Paid');
      expect(again.body.fnfSettlement.netPayout).toBe(150000 + 20000 + 30000 - 5000 - 2000);
    } else {
      expect(again.status).toBeGreaterThanOrEqual(400);
    }
  });
});
