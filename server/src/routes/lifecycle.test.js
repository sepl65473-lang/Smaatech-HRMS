// EMPLOYMENT LIFECYCLE EVENTS.
//
// Confirmation, probation, transfer, promotion and salary revision used to
// happen by editing the employee form: the previous value was overwritten and
// gone, there was no effective date, and a promotion was indistinguishable
// from a typo. These tests cover the record as much as the change.
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
const LifecycleEvent = (await import('../models/LifecycleEvent.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'LifecycleCo';

async function ensureRoles() {
  const roles = [
    { name: 'HR Manager', allowedActions: ['manageEmployees'] },
    { name: 'Finance Lead', allowedActions: ['managePayroll'] },
    { name: 'Employee', allowedActions: [] },
  ];
  for (const role of roles) {
    if (!(await Role.findOne({ name: role.name }))) {
      await Role.create({ description: role.name, allowedPaths: ['/'], ...role });
    }
  }
}

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@lifecycleco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();

  const manager = await Employee.create({
    name: 'Team Lead', role: 'Engineering Manager', dept: 'Engineering', loc: 'Bengaluru',
    company: COMPANY, status: 'active', joinDate: '2020-01-06', salary: 250000,
  });
  const emp = await Employee.create({
    name: 'New Joiner', role: 'Engineer', dept: 'Engineering', loc: 'Bengaluru',
    company: COMPANY, status: 'active', joinDate: '2026-01-05', salary: 100000, basic: 50000,
    employmentStage: 'Probation', probationEndDate: '2026-07-05',
  });

  return {
    manager,
    emp,
    admin: await seedUser('HR Director'),
    hr: await seedUser('HR Manager'),
    finance: await seedUser('Finance Lead'),
    employee: await seedUser('Employee', emp._id),
  };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
const post = (token, path, body) => request(app).post(`/api/v1${path}`).set(as(token)).send(body || {});

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('employment policy is configuration, not an invented constant', () => {
  it('reports defaults as UNCONFIRMED until HR sets them', async () => {
    const { hr } = await seed();
    const res = await request(app).get('/api/v1/lifecycle/policy').set(as(hr));
    expect(res.status).toBe(200);
    expect(res.body.confirmedByHR).toBe(false);
    expect(res.body.note).toMatch(/not been confirmed/i);
  });

  it('lets an admin set the policy, and then says it is confirmed', async () => {
    const { admin } = await seed();
    const res = await request(app).put('/api/v1/lifecycle/policy').set(as(admin)).send({
      probationMonths: 3, noticePeriodDays: 60, overtimeMultiplier: 1.5,
    });
    expect(res.status).toBe(200);
    expect(res.body.probationMonths).toBe(3);
    expect(res.body.noticePeriodDays).toBe(60);
    expect(res.body.confirmedByHR).toBe(true);

    // And it is actually applied, not just echoed back.
    const readBack = await request(app).get('/api/v1/lifecycle/policy').set(as(admin));
    expect(readBack.body.probationMonths).toBe(3);
  });

  it('rejects impossible policy values', async () => {
    const { admin } = await seed();
    for (const body of [
      { probationMonths: -1 }, { probationMonths: 999 },
      { overtimeMultiplier: 0 }, { dailyWorkHours: 40 }, { monthlyWorkingDays: 0 },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put('/api/v1/lifecycle/policy').set(as(admin)).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('is readable by an employee but writable only by an admin', async () => {
    const { employee, hr } = await seed();
    expect((await request(app).get('/api/v1/lifecycle/policy').set(as(employee))).status).toBe(200);
    expect((await request(app).put('/api/v1/lifecycle/policy').set(as(employee)).send({ probationMonths: 0 })).status).toBe(403);
    expect((await request(app).put('/api/v1/lifecycle/policy').set(as(hr)).send({ probationMonths: 0 })).status).toBe(403);
  });
});

describe('probation and confirmation', () => {
  it('derives the probation end date from the CONFIGURED policy, not a constant', async () => {
    const { admin, emp } = await seed();
    await request(app).put('/api/v1/lifecycle/policy').set(as(admin)).send({ probationMonths: 3 });

    const res = await post(admin, `/lifecycle/${emp._id}/probation/start`, { startFrom: '2026-02-01' });
    expect(res.status).toBe(201);
    expect(res.body.probationEndDate).toBe('2026-05-01');

    const stored = await Employee.findById(emp._id);
    expect(stored.employmentStage).toBe('Probation');
    expect(stored.probationEndDate).toBe('2026-05-01');
  });

  it('confirms an employee with an effective date and records both sides of the change', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/confirm`, {
      effectiveDate: '2026-07-06', note: 'Confirmed after review',
    });
    expect(res.status).toBe(201);

    const stored = await Employee.findById(emp._id);
    expect(stored.employmentStage).toBe('Confirmed');
    expect(stored.confirmationDate).toBe('2026-07-06');

    const event = await LifecycleEvent.findOne({ empId: emp._id, type: 'confirmed' });
    expect(event.effectiveDate).toBe('2026-07-06');
    expect(event.changes.employmentStage).toEqual({ from: 'Probation', to: 'Confirmed' });
    expect(event.actor.role).toBe('HR Manager');
  });

  it('cannot confirm the same person twice, however many times it is clicked', async () => {
    const { hr, emp } = await seed();
    const first = await post(hr, `/lifecycle/${emp._id}/confirm`, { effectiveDate: '2026-07-06' });
    expect(first.status).toBe(201);

    const second = await post(hr, `/lifecycle/${emp._id}/confirm`, { effectiveDate: '2026-08-01' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CONFIRMED');
    expect(await LifecycleEvent.countDocuments({ empId: emp._id, type: 'confirmed' })).toBe(1);
  });

  it('survives two simultaneous confirmations with a single event', async () => {
    const { hr, emp } = await seed();
    const results = await Promise.all([
      post(hr, `/lifecycle/${emp._id}/confirm`, { effectiveDate: '2026-07-06' }),
      post(hr, `/lifecycle/${emp._id}/confirm`, { effectiveDate: '2026-07-06' }),
      post(hr, `/lifecycle/${emp._id}/confirm`, { effectiveDate: '2026-07-06' }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await LifecycleEvent.countDocuments({ empId: emp._id, type: 'confirmed' })).toBe(1);
  });

  it('extends probation only with a reason, and moves the date', async () => {
    const { hr, emp } = await seed();

    const noReason = await post(hr, `/lifecycle/${emp._id}/probation/extend`, { months: 2 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');

    const extended = await post(hr, `/lifecycle/${emp._id}/probation/extend`, {
      months: 2, reason: 'Performance review pending',
    });
    expect(extended.status).toBe(201);
    expect(extended.body.probationEndDate).toBe('2026-09-05');
    expect((await Employee.findById(emp._id)).probationEndDate).toBe('2026-09-05');
  });

  it('refuses to extend probation for someone already confirmed', async () => {
    const { hr, emp } = await seed();
    await post(hr, `/lifecycle/${emp._id}/confirm`, {});
    const res = await post(hr, `/lifecycle/${emp._id}/probation/extend`, { months: 1, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ON_PROBATION');
  });

  it('lists who is due for a confirmation decision, flagging the overdue', async () => {
    const { hr } = await seed();
    await Employee.create({
      name: 'Overdue Person', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
      company: COMPANY, status: 'active', joinDate: '2025-01-01',
      employmentStage: 'Probation', probationEndDate: '2025-07-01',
    });
    await Employee.create({
      name: 'Not Due Yet', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
      company: COMPANY, status: 'active', joinDate: '2026-09-01',
      employmentStage: 'Probation', probationEndDate: '2027-03-01',
    });

    const res = await request(app).get('/api/v1/lifecycle/probation/due?withinDays=30').set(as(hr));
    expect(res.status).toBe(200);
    const names = res.body.due.map((d) => d.name);
    expect(names).toContain('Overdue Person');
    expect(names).not.toContain('Not Due Yet');
    expect(res.body.due.find((d) => d.name === 'Overdue Person').overdue).toBe(true);
  });
});

describe('transfer', () => {
  it('moves department, location and reporting line as one recorded event', async () => {
    const { hr, emp, manager } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/transfer`, {
      dept: 'Platform', loc: 'Pune', managerId: String(manager._id),
      effectiveDate: '2026-09-01', reason: 'Team restructure',
    });
    expect(res.status).toBe(201);

    const stored = await Employee.findById(emp._id);
    expect(stored.dept).toBe('Platform');
    expect(stored.loc).toBe('Pune');
    expect(String(stored.managerId)).toBe(String(manager._id));

    const event = await LifecycleEvent.findOne({ empId: emp._id, type: 'transferred' });
    expect(event.changes.dept).toEqual({ from: 'Engineering', to: 'Platform' });
    expect(event.effectiveDate).toBe('2026-09-01');
    expect(event.reason).toBe('Team restructure');
  });

  it('refuses a transfer that changes nothing', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/transfer`, { dept: 'Engineering' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_CHANGE');
  });

  it('refuses a reporting line that would create a cycle', async () => {
    const { hr, emp, manager } = await seed();
    // Make the manager report to the employee, then try to close the loop.
    await Employee.updateOne({ _id: manager._id }, { managerId: emp._id });

    const res = await post(hr, `/lifecycle/${emp._id}/transfer`, { managerId: String(manager._id) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORTING_CYCLE');
    expect((await Employee.findById(emp._id)).managerId).toBeNull();
  });

  it('refuses to make someone their own manager', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/transfer`, { managerId: String(emp._id) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_MANAGED');
  });

  it('refuses a manager from another company', async () => {
    const { hr, emp } = await seed();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Manager', dept: 'Eng', loc: 'Remote', company: 'OtherCo',
    });
    const res = await post(hr, `/lifecycle/${emp._id}/transfer`, { managerId: String(outsider._id) });
    expect(res.status).toBe(404);
  });
});

describe('promotion and salary revision', () => {
  it('records a promotion with its raise as one event', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/promote`, {
      role: 'Senior Engineer', salary: 130000, basic: 65000,
      effectiveDate: '2026-10-01', reason: 'Annual cycle',
    });
    expect(res.status).toBe(201);

    const stored = await Employee.findById(emp._id);
    expect(stored.role).toBe('Senior Engineer');
    expect(stored.salary).toBe(130000);
    expect(stored.basic).toBe(65000);

    const event = await LifecycleEvent.findOne({ empId: emp._id, type: 'promoted' });
    expect(event.changes.role).toEqual({ from: 'Engineer', to: 'Senior Engineer' });
    expect(event.changes.salary).toEqual({ from: 100000, to: 130000 });
  });

  it('refuses a promotion to the designation someone already holds', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/promote`, { role: 'Engineer' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_CHANGE');
  });

  it('records a salary revision, keeping the previous figure', async () => {
    const { hr, emp } = await seed();
    const res = await post(hr, `/lifecycle/${emp._id}/salary-revision`, {
      salary: 115000, basic: 57500, effectiveDate: '2026-11-01', reason: 'Mid-year correction',
    });
    expect(res.status).toBe(201);

    const event = await LifecycleEvent.findOne({ empId: emp._id, type: 'salary-revised' });
    expect(event.changes.salary).toEqual({ from: 100000, to: 115000 });
    expect((await Employee.findById(emp._id)).salary).toBe(115000);
  });

  it('demands a reason for a pay CUT', async () => {
    const { hr, emp } = await seed();
    const noReason = await post(hr, `/lifecycle/${emp._id}/salary-revision`, { salary: 80000 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    expect((await Employee.findById(emp._id)).salary).toBe(100000);

    const withReason = await post(hr, `/lifecycle/${emp._id}/salary-revision`, {
      salary: 80000, reason: 'Moved to part-time at employee request',
    });
    expect(withReason.status).toBe(201);
  });

  it('rejects impossible figures instead of storing them', async () => {
    const { hr, emp } = await seed();
    for (const body of [{ salary: -1 }, { salary: 2e9 }, { salary: 'lots' }, { salary: 120000, basic: 200000 }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(hr, `/lifecycle/${emp._id}/salary-revision`, body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await Employee.findById(emp._id)).salary).toBe(100000);
  });
});

describe('history and access', () => {
  it('gives an employee their OWN history and nobody else\'s', async () => {
    const { hr, employee, emp, manager } = await seed();
    await post(hr, `/lifecycle/${emp._id}/confirm`, {});
    await post(hr, `/lifecycle/${manager._id}/promote`, { role: 'Director' });

    const own = await request(app).get('/api/v1/lifecycle/events').set(as(employee));
    expect(own.status).toBe(200);
    expect(own.body.every((e) => String(e.empId) === String(emp._id))).toBe(true);

    const someoneElse = await request(app)
      .get(`/api/v1/lifecycle/events?empId=${manager._id}`).set(as(employee));
    expect(someoneElse.status).toBe(403);
  });

  it('lets HR and Finance read anyone history', async () => {
    const { hr, finance, emp } = await seed();
    await post(hr, `/lifecycle/${emp._id}/confirm`, {});
    for (const token of [hr, finance]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/api/v1/lifecycle/events?empId=${emp._id}`).set(as(token));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('refuses every lifecycle write to an ordinary employee', async () => {
    const { employee, emp } = await seed();
    for (const path of ['confirm', 'promote', 'transfer', 'salary-revision', 'probation/extend', 'probation/start']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(employee, `/lifecycle/${emp._id}/${path}`, { role: 'CEO', salary: 9999999, dept: 'Board', months: 1, reason: 'x' });
      expect(res.status, `${path} was allowed`).toBe(403);
    }
    const stored = await Employee.findById(emp._id);
    expect(stored.salary).toBe(100000);
    expect(stored.role).toBe('Engineer');
    expect(await LifecycleEvent.countDocuments()).toBe(0);
  });

  it('refuses Finance a salary revision — reading pay is not changing it', async () => {
    const { finance, emp } = await seed();
    const res = await post(finance, `/lifecycle/${emp._id}/salary-revision`, { salary: 500000 });
    expect(res.status).toBe(403);
  });

  it('never touches an employee in another company', async () => {
    const { hr } = await seed();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Engineer', dept: 'Eng', loc: 'Remote', company: 'OtherCo', salary: 50000,
    });
    const res = await post(hr, `/lifecycle/${outsider._id}/salary-revision`, { salary: 999999 });
    expect(res.status).toBe(404);
    expect((await Employee.findById(outsider._id)).salary).toBe(50000);
  });

  it('audits every lifecycle change', async () => {
    const { hr, emp } = await seed();
    await post(hr, `/lifecycle/${emp._id}/promote`, { role: 'Senior Engineer', salary: 130000 });

    const log = await AuditLog.findOne({ action: 'Lifecycle: promoted' });
    expect(log).toBeTruthy();
    expect(log.subject).toBe('New Joiner');
    expect(log.details).toMatch(/Engineer → Senior Engineer/);
  });

  it('refuses any lifecycle event on someone who has left', async () => {
    const { hr, emp } = await seed();
    await Employee.updateOne({ _id: emp._id }, { employmentStage: 'Exited' });
    for (const [path, body] of [
      ['confirm', {}],
      ['promote', { role: 'Director' }],
      ['salary-revision', { salary: 200000 }],
      ['transfer', { dept: 'Platform' }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(hr, `/lifecycle/${emp._id}/${path}`, body);
      expect(res.status, `${path} was allowed on an exited employee`).toBe(409);
    }
  });
});
