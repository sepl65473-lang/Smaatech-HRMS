// Session/token invalidation on every lifecycle exit.
//
// Before this, an access token lived 15 minutes and NOTHING re-checked the
// account behind it on a normal API call — only /auth/me and /auth/refresh
// looked at `active`. So a deactivated, demoted, terminated or deleted person
// kept full working access to every endpoint (payroll, documents, employee
// records) for the remainder of that window, and kept a valid 30-day refresh
// token that no lifecycle path ever revoked.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => ({ sent: true })),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const RefreshToken = (await import('../models/RefreshToken.js')).default;
const Resignation = (await import('../models/Resignation.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'ExitCo';

async function ensureRoles() {
  for (const name of ['HR Director', 'HR Manager', 'Finance Lead', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, allowedActions: name === 'HR Manager' ? ['manageEmployees', 'manageUsers'] : [] });
    }
  }
}

async function seedUser(role, key, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key}@example.com`;
  const user = await User.create({ name: key, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { user, token: login.body.accessToken, cookie: login.headers['set-cookie'] };
}

async function scenario() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  const emp = await Employee.create({ name: 'Leaver', dept: 'Engineering', company: COMPANY, salary: 50000 });
  const victim = await seedUser('Employee', 'leaver', emp._id);
  const director = await seedUser('HR Director', 'director');
  const finance = await seedUser('Finance Lead', 'finance');
  return { emp, victim, director, finance };
}

// A normal, non-auth endpoint — the point is that ORDINARY API access stops,
// not just /auth/me.
function callProtectedEndpoint(token) {
  return request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

describe('deactivating a login', () => {
  it('stops the existing access token working IMMEDIATELY on ordinary endpoints', async () => {
    const { victim, director } = await scenario();
    expect((await callProtectedEndpoint(victim.token)).status).toBe(200);

    const patched = await request(app)
      .patch(`/api/v1/users/${victim.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ active: false });
    expect(patched.status).toBe(200);

    const after = await callProtectedEndpoint(victim.token);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('revokes every live refresh token', async () => {
    const { victim, director } = await scenario();
    expect(await RefreshToken.countDocuments({ userId: victim.user._id, revokedAt: null })).toBe(1);

    await request(app)
      .patch(`/api/v1/users/${victim.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ active: false });

    expect(await RefreshToken.countDocuments({ userId: victim.user._id, revokedAt: null })).toBe(0);
  });

  it('refuses to refresh with the old cookie', async () => {
    const { victim, director } = await scenario();
    await request(app)
      .patch(`/api/v1/users/${victim.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ active: false });

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', victim.cookie);
    expect([401, 403]).toContain(refreshed.status);
  });
});

describe('changing a role', () => {
  it('invalidates the old token so the previous role cannot be used', async () => {
    const { victim, director } = await scenario();
    await request(app)
      .patch(`/api/v1/users/${victim.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ role: 'HR Manager' });

    const after = await callProtectedEndpoint(victim.token);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_REVOKED');
  });
});

describe('admin password reset', () => {
  it('signs the account out everywhere', async () => {
    const { victim, director } = await scenario();
    await request(app)
      .patch(`/api/v1/users/${victim.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ password: 'BrandNewPass123' });

    expect((await callProtectedEndpoint(victim.token)).status).toBe(401);
    expect(await RefreshToken.countDocuments({ userId: victim.user._id, revokedAt: null })).toBe(0);
  });
});

describe('last-admin protection', () => {
  it('refuses to demote the only remaining HR Director', async () => {
    const { director } = await scenario();
    const res = await request(app)
      .patch(`/api/v1/users/${director.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ role: 'Employee' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('refuses to deactivate the only remaining HR Director', async () => {
    const { director } = await scenario();
    const res = await request(app)
      .patch(`/api/v1/users/${director.user._id}`)
      .set('Authorization', `Bearer ${director.token}`)
      .send({ active: false });
    expect(res.status).toBe(409);
  });

  it('refuses to let an admin delete the account they are signed in with', async () => {
    const { director } = await scenario();
    const res = await request(app)
      .delete(`/api/v1/users/${director.user._id}`)
      .set('Authorization', `Bearer ${director.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_DELETE_SELF');
  });
});

describe('deleting an employee record', () => {
  it('deactivates the linked login and kills its sessions', async () => {
    const { emp, victim, director } = await scenario();
    const res = await request(app)
      .delete(`/api/v1/employees/${emp._id}`)
      .set('Authorization', `Bearer ${director.token}`);
    expect(res.status).toBe(200);

    const stored = await User.findById(victim.user._id);
    expect(stored.active).toBe(false);
    expect(stored.employeeId).toBeNull();
    expect(await RefreshToken.countDocuments({ userId: victim.user._id, revokedAt: null })).toBe(0);
    expect((await callProtectedEndpoint(victim.token)).status).toBe(403);
  });

  it('unlinks direct reports so they do not point at a deleted manager', async () => {
    const { emp, director } = await scenario();
    const report = await Employee.create({ name: 'Report', company: COMPANY, managerId: emp._id });

    await request(app).delete(`/api/v1/employees/${emp._id}`).set('Authorization', `Bearer ${director.token}`);
    expect((await Employee.findById(report._id)).managerId).toBeNull();
  });

  it('soft delete also terminates access', async () => {
    const { emp, victim, director } = await scenario();
    await request(app)
      .delete(`/api/v1/employees/${emp._id}?soft=true`)
      .set('Authorization', `Bearer ${director.token}`);

    expect((await Employee.findById(emp._id)).status).toBe('terminated');
    expect((await User.findById(victim.user._id)).active).toBe(false);
    expect((await callProtectedEndpoint(victim.token)).status).toBe(403);
  });
});

describe('F&F payout guards and exit', () => {
  async function fileAndProcess(scn) {
    const filed = await Resignation.create({
      employeeId: scn.emp._id,
      employeeName: scn.emp.name,
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-08-01',
      reason: 'Moving on',
      clearances: [
        { dept: 'IT', status: 'Pending' },
        { dept: 'Finance', status: 'Pending' },
        { dept: 'HR', status: 'Pending' },
        { dept: 'Admin', status: 'Pending' },
      ],
      company: COMPANY,
    });
    return filed;
  }

  it('refuses to pay a settlement that was never calculated', async () => {
    const scn = await scenario();
    const filed = await fileAndProcess(scn);

    // The old handler set `resignation.fnfSettlement.status = 'Paid'` on an
    // undefined object and threw a 500.
    const res = await request(app)
      .post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${scn.finance.token}`)
      .send({ overrideClearances: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FNF_NOT_PROCESSED');
  });

  it('blocks payout while clearances are outstanding, and names them', async () => {
    const scn = await scenario();
    const filed = await fileAndProcess(scn);
    await request(app).post(`/api/v1/resignations/${filed._id}/fnf`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({ monthlySalary: 50000 });

    const res = await request(app)
      .post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLEARANCES_PENDING');
    expect(res.body.error.outstanding).toEqual(expect.arrayContaining(['IT', 'Finance', 'HR', 'Admin']));
  });

  it('terminates the exited employee access on payout', async () => {
    const scn = await scenario();
    const filed = await fileAndProcess(scn);
    await request(app).post(`/api/v1/resignations/${filed._id}/fnf`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({ monthlySalary: 50000 });

    const res = await request(app)
      .post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${scn.finance.token}`)
      .send({ overrideClearances: true });
    expect(res.status).toBe(200);

    expect((await Employee.findById(scn.emp._id)).status).toBe('exited');
    expect((await User.findById(scn.victim.user._id)).active).toBe(false);
    expect(await RefreshToken.countDocuments({ userId: scn.victim.user._id, revokedAt: null })).toBe(0);
    // The decisive check: their outstanding access token is dead NOW.
    expect((await callProtectedEndpoint(scn.victim.token)).status).toBe(403);
  });

  it('cannot be paid twice', async () => {
    const scn = await scenario();
    const filed = await fileAndProcess(scn);
    await request(app).post(`/api/v1/resignations/${filed._id}/fnf`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({ monthlySalary: 50000 });

    const first = await request(app).post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({ overrideClearances: true });
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${scn.finance.token}`).send({ overrideClearances: true });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('FNF_NOT_PROCESSED');
  });

  it('cannot be marked Paid through the generic PATCH route', async () => {
    const scn = await scenario();
    const filed = await fileAndProcess(scn);

    await request(app)
      .patch(`/api/v1/resignations/${filed._id}`)
      .set('Authorization', `Bearer ${scn.director.token}`)
      .send({ fnfSettlement: { status: 'Paid', netPayout: 999999 }, company: 'OtherCo' });

    const stored = await Resignation.findById(filed._id);
    expect(stored.fnfSettlement?.status).not.toBe('Paid');
    expect(stored.company).toBe(COMPANY);
  });
});
