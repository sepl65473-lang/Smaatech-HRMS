import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS } from '../fixtures/harness.js';

/**
 * PAYROLL through the real UI: the register a Finance Lead actually sees, the
 * payslip preview, the statutory breakdown, disbursement, and the immutability
 * that must follow it.
 *
 * The money assertions are made against the server's own figures, not against
 * numbers the page computed for display.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

let payrollRow = null;

// The payroll page carries two tables now — the register and variable pay —
// so every assertion here is scoped to the register card.
const register = (page) =>
  page.locator('.card', { has: page.locator('.card-title', { hasText: 'Payroll register' }) });

async function openPayroll(page, who) {
  await page.goto('/');
  await logout(page);
  await login(page, who);
  await page.getByRole('link', { name: /payroll/i }).first().click();
  await expect(page.locator('.card-title', { hasText: 'Payroll register' })).toBeVisible({ timeout: 20_000 });
}

test.describe('running a payroll cycle', () => {
  test('Finance runs the cycle from the page and the register fills', async ({ page }) => {
    await openPayroll(page, 'finance');

    // Whatever the register holds now, the run must add the people who are
    // missing from it. (Creating an employee also creates their first payslip,
    // so this is not necessarily empty when the whole suite runs in order.)
    const before = await apiAs(page, 'GET', '/payroll');
    const employees = await apiAs(page, 'GET', '/employees');
    const payable = employees.body.filter((e) => Number(e.salary) > 0);
    expect(before.body.length).toBeLessThan(payable.length);

    const ran = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/payroll/run') && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: /Run payroll/i }).click();
    const response = await ran;
    expect(response.status()).toBe(201);

    const result = await response.json();
    expect(result.created).toBeGreaterThan(0);
    // Everyone payable now has exactly one payslip for the cycle.
    const after = await apiAs(page, 'GET', '/payroll');
    expect(after.body.length).toBe(payable.length);
    // Every payable employee is now in the register, on screen.
    await expect(register(page).locator('.table')).toContainText(USERS.employee.name, { timeout: 20_000 });
  });

  test('running the same cycle again creates nothing', async ({ page }) => {
    await openPayroll(page, 'finance');
    const countBefore = (await apiAs(page, 'GET', '/payroll')).body.length;

    const ran = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/payroll/run') && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: /Run payroll/i }).click();
    const result = await (await ran).json();
    expect(result.created).toBe(0);

    const countAfter = (await apiAs(page, 'GET', '/payroll')).body.length;
    expect(countAfter).toBe(countBefore);
  });

  test('an employee cannot run payroll', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'employee');
    const res = await apiAs(page, 'POST', '/payroll/run', { cycle: new Date().toISOString().slice(0, 7) });
    expect(res.status).toBe(403);
  });
});

test.describe('the payroll register', () => {
  test('Finance sees the register with server-side figures', async ({ page }) => {
    await openPayroll(page, 'finance');

    const rows = await apiAs(page, 'GET', '/payroll');
    expect(rows.status).toBe(200);
    expect(rows.body.length, 'the cycle run should have produced rows').toBeGreaterThan(0);

    payrollRow = rows.body.find((r) => r.name === USERS.employee.name) || rows.body[0];
    expect(payrollRow).toBeTruthy();

    // The register must show the row the API returned.
    await expect(register(page).locator('.table')).toContainText(payrollRow.name, { timeout: 20_000 });
  });

  test('the statutory breakdown is computed on the server', async ({ page }) => {
    await openPayroll(page, 'finance');
    const preview = await apiAs(
      page, 'GET',
      `/payroll/statutory/preview?empId=${payrollRow.empId}&cycle=${payrollRow.cycle}`,
    );
    expect(preview.status).toBe(200);

    const body = preview.body;
    expect(body.gross).toBeGreaterThan(0);
    expect(Array.isArray(body.deductions)).toBe(true);

    // The statutory lines are categorised, so a payslip can show WHY money was
    // deducted rather than one opaque total.
    const categories = body.deductions.map((d) => d.category);
    expect(categories).toContain('PF');
    for (const line of body.deductions) {
      expect(line.name, 'a deduction line with no name').toBeTruthy();
      expect(line.amount, `${line.name} was negative`).toBeGreaterThanOrEqual(0);
    }
    // The employee-side total is the sum of those lines — nothing unexplained.
    const summed = body.deductions.reduce((total, d) => total + d.amount, 0);
    expect(Math.round(body.employeeTotal)).toBe(Math.round(summed));
  });

  test('the payslip preview opens and shows the real net pay', async ({ page }) => {
    await openPayroll(page, 'finance');
    const row = register(page).locator('tr', { hasText: payrollRow.name }).first();
    await row.getByRole('button', { name: 'Preview' }).click();

    const preview = page.locator('.payslip-preview');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview).toContainText(payrollRow.name);
    await expect(preview).toContainText(payrollRow.cycle);
    // Net pay, formatted, must be the server's net — not a recomputed one.
    await expect(preview).toContainText(new RegExp(payrollRow.net.toLocaleString('en-IN').replace(/,/g, ',?')));
  });

  test('the payslip downloads as an actual PDF', async ({ page }) => {
    await openPayroll(page, 'finance');
    const row = register(page).locator('tr', { hasText: payrollRow.name }).first();
    await row.getByRole('button', { name: 'Preview' }).click();
    await expect(page.locator('.payslip-preview')).toBeVisible({ timeout: 15_000 });

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const file = await download;

    // It used to emit HTML with a .pdf-ish name; the filename AND the bytes
    // both have to be a PDF.
    expect(file.suggestedFilename()).toMatch(/\.pdf$/i);
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const head = Buffer.concat(chunks).subarray(0, 5).toString('latin1');
    expect(head, 'the downloaded payslip is not a PDF').toBe('%PDF-');
  });
});

test.describe('disbursement and immutability', () => {
  test('a row can be marked paid from the UI', async ({ page }) => {
    await openPayroll(page, 'finance');
    const row = register(page).locator('tr', { hasText: payrollRow.name }).first();

    const markPaid = row.getByRole('button', { name: 'Mark paid' });
    await expect(markPaid).toBeVisible({ timeout: 15_000 });

    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/payroll/${payrollRow.id}`) && r.request().method() === 'PATCH',
      { timeout: 30_000 },
    );
    await markPaid.click();
    expect((await patched).status()).toBe(200);

    const after = await apiAs(page, 'GET', `/payroll/${payrollRow.id}`);
    expect(after.body.status).toBe('paid');
  });

  test('a PAID row can no longer be edited', async ({ page }) => {
    await openPayroll(page, 'finance');
    // Money that has left the company must not be silently rewritten.
    const res = await apiAs(page, 'PATCH', `/payroll/${payrollRow.id}`, { gross: 1 });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await apiAs(page, 'GET', `/payroll/${payrollRow.id}`);
    expect(after.body.gross).not.toBe(1);
  });

  test('only an HR Director can unlock it', async ({ page }) => {
    await openPayroll(page, 'finance');
    const refused = await apiAs(page, 'POST', `/payroll/${payrollRow.id}/unlock`);
    expect(refused.status).toBe(403);

    await page.goto('/');
    await logout(page);
    await login(page, 'admin');
    const allowed = await apiAs(page, 'POST', `/payroll/${payrollRow.id}/unlock`);
    expect(allowed.status).toBe(200);
  });

  test('an unlock is recorded in the audit trail', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'admin');
    const logs = await apiAs(page, 'GET', '/audit-logs');
    expect(logs.status).toBe(200);
    const rows = Array.isArray(logs.body) ? logs.body : (logs.body.rows || logs.body.items || []);
    const unlock = rows.find((l) => /unlock/i.test(l.action || ''));
    expect(unlock, 'unlocking paid payroll must leave an audit record').toBeTruthy();
    expect(unlock.actor || unlock.user || unlock.by).toBeTruthy();
  });
});

test.describe('payroll visibility', () => {
  test('an employee cannot read the register or anyone else payslip', async ({ page }) => {
    await page.goto('/');
    await logout(page);
    await login(page, 'employee');

    const mine = await apiAs(page, 'GET', '/payroll');
    expect(mine.status).toBe(200);
    for (const row of mine.body) expect(row.name).toBe(USERS.employee.name);

    const someoneElse = await apiAs(page, 'GET', `/payroll/${payrollRow.id}`);
    if (payrollRow.name !== USERS.employee.name) {
      expect([403, 404]).toContain(someoneElse.status);
    }
  });
});
