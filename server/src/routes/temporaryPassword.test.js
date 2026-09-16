// FIRST-LOGIN PASSWORD CHANGE.
//
// "You must change your password" was a banner and an unclosable modal — and
// nothing else. The page behind it still rendered and every API endpoint still
// answered, so anyone holding the temporary password that was emailed to them
// had complete access to the application without ever changing it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;

const TEMP_PASSWORD = 'TempPass123';
const NEW_PASSWORD = 'ChosenPass456';
const COMPANY = 'TempPwCo';

async function seed({ mustChange = true } = {}) {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  if (!(await Role.findOne({ name: 'Employee' }))) {
    await Role.create({ name: 'Employee', description: 'ESS', allowedPaths: ['/'], allowedActions: [] });
  }

  const employee = await Employee.create({
    name: 'New Starter', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active', salary: 90000,
  });
  const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 10);
  await User.create({
    name: 'New Starter', email: 'starter@temppwco.example.com', passwordHash,
    role: 'Employee', company: COMPANY, active: true,
    employeeId: employee._id, mustChangePassword: mustChange,
  });

  const login = await request(app).post('/api/v1/auth/login')
    .send({ email: 'starter@temppwco.example.com', password: TEMP_PASSWORD });
  return { employee, token: login.body.accessToken, login };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('while the temporary password is still in force', () => {
  it('signs in successfully and says the password must change', async () => {
    const { login } = await seed();
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    // The client needs to know, so it can put the person straight into the form.
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('REFUSES every ordinary endpoint, not just the UI', async () => {
    const { token } = await seed();
    for (const path of ['/employees', '/attendance', '/leaves', '/payroll', '/documents', '/notifications']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/api/v1${path}`).set(as(token));
      expect(res.status, `${path} was reachable on a temporary password`).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('refuses writes too', async () => {
    const { token, employee } = await seed();
    const res = await request(app).post('/api/v1/leaves').set(as(token)).send({
      empId: employee._id, type: 'casual', start: '2026-12-01', end: '2026-12-02', reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('still allows the routes needed to fix it', async () => {
    const { token } = await seed();
    expect((await request(app).get('/api/v1/auth/me').set(as(token))).status).toBe(200);
  });
});

describe('changing the password', () => {
  it('works, and immediately unlocks the application', async () => {
    const { token } = await seed();

    const changed = await request(app).post('/api/v1/auth/change-password').set(as(token))
      .send({ currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);

    // No waiting out the account-state cache: the very next request works.
    const after = await request(app).get('/api/v1/employees').set(as(token));
    expect(after.status).toBe(200);

    const stored = await User.findOne({ email: 'starter@temppwco.example.com' });
    expect(stored.mustChangePassword).toBe(false);
  });

  it('stores a hash, never the password itself', async () => {
    const { token } = await seed();
    await request(app).post('/api/v1/auth/change-password').set(as(token))
      .send({ currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD });

    const stored = await User.findOne({ email: 'starter@temppwco.example.com' });
    expect(stored.passwordHash).not.toContain(NEW_PASSWORD);
    expect(stored.passwordHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, stored.passwordHash)).toBe(true);
  });

  it('refuses a change without the current password', async () => {
    const { token } = await seed();
    const res = await request(app).post('/api/v1/auth/change-password').set(as(token))
      .send({ currentPassword: 'WrongPass123', newPassword: NEW_PASSWORD });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // And the account is still locked down.
    expect((await request(app).get('/api/v1/employees').set(as(token))).status).toBe(403);
  });

  it('lets the person sign in with the new password afterwards', async () => {
    const { token } = await seed();
    await request(app).post('/api/v1/auth/change-password').set(as(token))
      .send({ currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD });

    const relogin = await request(app).post('/api/v1/auth/login')
      .send({ email: 'starter@temppwco.example.com', password: NEW_PASSWORD });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.mustChangePassword).toBe(false);

    const old = await request(app).post('/api/v1/auth/login')
      .send({ email: 'starter@temppwco.example.com', password: TEMP_PASSWORD });
    expect(old.status).toBe(401);
  });
});

describe('an ordinary account is unaffected', () => {
  it('works normally when no password change is pending', async () => {
    const { token } = await seed({ mustChange: false });
    expect((await request(app).get('/api/v1/employees').set(as(token))).status).toBe(200);
  });
});
