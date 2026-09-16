import { test, expect } from '@playwright/test';
import { login, logout } from '../fixtures/actions.js';
import { apiAs } from '../fixtures/api.js';
import { USERS, E2E_SECRET, WEB_BASE } from '../fixtures/harness.js';

/**
 * Role authorization, in the browser, for every role.
 *
 * Two halves, and BOTH matter:
 *   - what the UI shows (convenience)
 *   - what the API actually allows for that same live session (the control)
 *
 * Hidden UI is not security, so every visibility assertion is paired with a
 * backend check made from inside the same signed-in browser session.
 */

test.describe.configure({ mode: 'serial' });

async function as(page, who) {
  await page.goto('/');
  await logout(page);
  return login(page, who);
}

test.describe('salary and PII exposure', () => {
  test('an EMPLOYEE cannot read a colleague salary or bank details', async ({ page }) => {
    await as(page, 'employee');
    const res = await apiAs(page, 'GET', '/employees');
    expect(res.status).toBe(200);

    const colleague = res.body.find((e) => e.name === USERS.hr.name);
    expect(colleague).toBeTruthy();
    for (const field of ['salary', 'basic', 'bankAccount', 'ifsc', 'pan', 'uan', 'esiNumber']) {
      expect(colleague[field], `employee could read "${field}"`).toBeUndefined();
    }
    // Directory information is still there, so the UI keeps working.
    expect(colleague.name).toBeTruthy();
    expect(colleague.dept).toBeTruthy();
  });

  test('an EMPLOYEE can read their OWN salary', async ({ page }) => {
    await as(page, 'employee');
    const res = await apiAs(page, 'GET', '/employees');
    const own = res.body.find((e) => e.name === USERS.employee.name);
    expect(own.salary).toBe(150000);
  });

  test('a MANAGER sees their report working details but NOT their pay', async ({ page }) => {
    // managerId is an organisational relationship, not a compensation grant.
    await as(page, 'manager');
    const res = await apiAs(page, 'GET', '/employees');
    const report = res.body.find((e) => e.name === USERS.employee.name);
    expect(report).toBeTruthy();
    expect(report.dob).toBeTruthy();          // line-management detail
    expect(report.salary).toBeUndefined();    // compensation
    expect(report.bankAccount).toBeUndefined();
  });

  test('HR and Finance can read full profiles', async ({ page }) => {
    for (const who of ['hr', 'finance']) {
      await as(page, who);
      const res = await apiAs(page, 'GET', '/employees');
      const target = res.body.find((e) => e.name === USERS.employee.name);
      expect(target.salary, `${who} could not read salary`).toBe(150000);
    }
  });
});

test.describe('settings secrets', () => {
  test('gateway credentials never reach any role', async ({ page }) => {
    for (const who of ['employee', 'hr', 'admin']) {
      await as(page, who);
      const res = await apiAs(page, 'GET', '/settings');
      expect(res.status).toBe(200);
      const serialised = JSON.stringify(res.body);
      for (const key of ['gatewaySmtpPass', 'gatewayTwilioToken', 'gatewaySendgridKey', 'biometricDeviceApiKey']) {
        expect(serialised, `${who} received "${key}"`).not.toContain(`"${key}":"`);
      }
    }
  });
});

test.describe('privileged endpoints', () => {
  const cases = [
    { path: '/users', allowed: ['admin'], denied: ['employee', 'manager', 'hr', 'finance'] },
    { path: '/audit-logs', allowed: ['admin'], denied: ['employee', 'manager', 'finance'] },
    { path: '/attendance/verification/attempts', allowed: ['admin', 'hr'], denied: ['employee', 'manager', 'finance'] },
  ];

  for (const { path, allowed, denied } of cases) {
    test(`GET ${path} is restricted correctly`, async ({ page }) => {
      for (const who of denied) {
        await as(page, who);
        const res = await apiAs(page, 'GET', path);
        expect({ who, path, status: res.status }).toEqual({ who, path, status: 403 });
      }
      for (const who of allowed) {
        await as(page, who);
        const res = await apiAs(page, 'GET', path);
        expect({ who, path, ok: res.status < 400 }).toEqual({ who, path, ok: true });
      }
    });
  }

  test('an employee cannot create a login for themselves', async ({ page }) => {
    await as(page, 'employee');
    const res = await apiAs(page, 'POST', '/users', {
      name: 'Sneaky', email: 'sneaky@example.com', password: 'StrongPass123', role: 'HR Director',
    });
    expect(res.status).toBe(403);
  });

  test('an employee cannot raise their own salary', async ({ page }) => {
    await as(page, 'employee');
    const list = await apiAs(page, 'GET', '/employees');
    const own = list.body.find((e) => e.name === USERS.employee.name);

    await apiAs(page, 'PATCH', `/employees/${own.id}`, { salary: 9999999, role: 'HR Director' });

    const after = await apiAs(page, 'GET', '/employees');
    const checked = after.body.find((e) => e.id === own.id);
    expect(checked.salary).toBe(150000);
    expect(checked.role).not.toBe('HR Director');
  });

  test('an employee sees only their OWN payroll', async ({ page }) => {
    await as(page, 'employee');
    const res = await apiAs(page, 'GET', '/payroll');
    expect(res.status).toBe(200);
    // Nothing belonging to anyone else.
    for (const row of res.body) {
      expect(row.name).toBe(USERS.employee.name);
    }
  });
});

test.describe('session revocation in a live browser', () => {
  test('deactivating an account ends its still-open browser session', async ({ page, browser }) => {
    // Sign the employee in and confirm the session works.
    await as(page, 'employee');
    const before = await apiAs(page, 'GET', '/employees');
    expect(before.status).toBe(200);

    // An admin deactivates them from a SEPARATE browser session, the way a
    // real offboarding happens while the person still has a tab open.
    const adminContext = await browser.newContext({
      extraHTTPHeaders: { 'X-E2E-Secret': E2E_SECRET },
      permissions: ['geolocation'],
      geolocation: { latitude: 19.0760, longitude: 72.8777, accuracy: 10 },
      baseURL: WEB_BASE,
    });
    const adminPage = await adminContext.newPage();
    try {
      await login(adminPage, 'admin');
      const users = await apiAs(adminPage, 'GET', '/users');
      const target = users.body.find((u) => u.email === USERS.employee.email);
      expect(target).toBeTruthy();

      const patched = await apiAs(adminPage, 'PATCH', `/users/${target.id}`, { active: false });
      expect(patched.status).toBe(200);

      // The employee's ALREADY-OPEN session must stop working immediately —
      // not at the next token expiry.
      const after = await apiAs(page, 'GET', '/employees');
      expect([401, 403]).toContain(after.status);

      // Restore, so the specs that follow are unaffected.
      const restored = await apiAs(adminPage, 'PATCH', `/users/${target.id}`, { active: true });
      expect(restored.status).toBe(200);
    } finally {
      await adminContext.close();
    }
  });
});
