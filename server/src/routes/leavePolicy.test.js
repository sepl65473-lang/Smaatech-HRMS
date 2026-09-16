// LEAVE POLICY CONFIGURATION.
//
// The quotas and accrual rules used to be seeded constants nobody could edit,
// so every balance in the system enforced numbers HR had never agreed to.
// These tests cover making the policy the company's own — and, just as
// importantly, the history it must not damage on the way.
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
const Leave = (await import('../models/Leave.js')).default;
const LeaveType = (await import('../models/LeaveType.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'PolicyCo';

async function ensureRoles() {
  const roles = [
    { name: 'HR Manager', allowedActions: ['manageLeave'] },
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
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@policyco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  const emp = await Employee.create({
    name: 'Policy Person', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active',
  });
  return { emp, hr: await seedUser('HR Manager'), employee: await seedUser('Employee', emp._id) };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('reading the policy', () => {
  it('seeds a usable default policy for a company that has never configured one', async () => {
    const { hr } = await seed();
    const res = await request(app).get('/api/v1/leaves/types').set(as(hr));
    expect(res.status).toBe(200);
    const codes = res.body.map((t) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['casual', 'sick', 'earned', 'unpaid']));
  });

  it('hides retired types from everyone, and shows them to HR on request', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));
    await LeaveType.updateOne({ company: COMPANY, code: 'paternity' }, { active: false });

    const normal = await request(app).get('/api/v1/leaves/types').set(as(hr));
    expect(normal.body.map((t) => t.code)).not.toContain('paternity');

    const all = await request(app).get('/api/v1/leaves/types?includeInactive=true').set(as(hr));
    expect(all.body.map((t) => t.code)).toContain('paternity');
  });
});

describe('changing the policy', () => {
  it('lets HR change a quota, and says plainly that existing balances are untouched', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr)); // seed defaults

    const res = await request(app)
      .patch('/api/v1/leaves/types/casual').set(as(hr))
      .send({ annualQuota: 18, accrualMode: 'annual', name: 'Casual Leave (revised)' });

    expect(res.status).toBe(200);
    expect(res.body.annualQuota).toBe(18);
    expect(res.body.accrualMode).toBe('annual');
    // The ledger is a record of what happened; a policy change is not a licence
    // to rewrite it, and the caller is told so rather than left to assume.
    expect(res.body.note).toMatch(/Existing balances are unchanged/i);

    const stored = await LeaveType.findOne({ company: COMPANY, code: 'casual' });
    expect(stored.annualQuota).toBe(18);
  });

  it('never lets the code change, because the ledger joins on it', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));

    await request(app).patch('/api/v1/leaves/types/casual').set(as(hr))
      .send({ code: 'renamed', annualQuota: 10 });

    expect(await LeaveType.findOne({ company: COMPANY, code: 'casual' })).toBeTruthy();
    expect(await LeaveType.findOne({ company: COMPANY, code: 'renamed' })).toBeNull();
  });

  it('rejects nonsense values instead of storing them', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));

    for (const body of [{ annualQuota: -5 }, { annualQuota: 5000 }, { accrualMode: 'whenever' }, { name: '  ' }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).patch('/api/v1/leaves/types/casual').set(as(hr)).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
    const stored = await LeaveType.findOne({ company: COMPANY, code: 'casual' });
    expect(stored.annualQuota).toBe(12);
  });

  it('records every policy change in the audit trail', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));
    await request(app).patch('/api/v1/leaves/types/sick').set(as(hr)).send({ annualQuota: 20 });

    const AuditLog = (await import('../models/AuditLog.js')).default;
    const log = await AuditLog.findOne({ action: 'Leave policy changed' });
    expect(log).toBeTruthy();
    expect(log.details).toMatch(/annualQuota/);
  });
});

describe('adding and retiring types', () => {
  it('adds a company-specific type that can then be applied for', async () => {
    const { hr, emp } = await seed();
    const created = await request(app).post('/api/v1/leaves/types').set(as(hr)).send({
      code: 'bereavement', name: 'Bereavement Leave', annualQuota: 5, accrualMode: 'annual', paid: true,
    });
    expect(created.status).toBe(201);

    const filed = await request(app).post('/api/v1/leaves').set(as(hr)).send({
      empId: emp._id, type: 'bereavement', start: '2026-11-02', end: '2026-11-03', reason: 'Family',
    });
    expect(filed.status).toBe(201);
    expect(filed.body.type).toBe('bereavement');
  });

  it('refuses a duplicate code and a malformed one', async () => {
    const { hr } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));

    const dupe = await request(app).post('/api/v1/leaves/types').set(as(hr)).send({ code: 'casual', name: 'Another' });
    expect(dupe.status).toBe(409);

    for (const code of ['', 'A', 'has space', 'WITH-CAPS!', '-']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/v1/leaves/types').set(as(hr)).send({ code, name: 'x' });
      expect(res.status, `accepted code "${code}"`).toBe(400);
    }
  });

  it('deletes an UNUSED type outright', async () => {
    const { hr } = await seed();
    await request(app).post('/api/v1/leaves/types').set(as(hr)).send({ code: 'sabbatical', name: 'Sabbatical' });

    const res = await request(app).delete('/api/v1/leaves/types/sabbatical').set(as(hr));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(await LeaveType.findOne({ company: COMPANY, code: 'sabbatical' })).toBeNull();
  });

  it('RETIRES a type people have actually used, rather than orphaning their history', async () => {
    const { hr, emp } = await seed();
    await request(app).get('/api/v1/leaves/types').set(as(hr));
    await request(app).post('/api/v1/leaves').set(as(hr)).send({
      empId: emp._id, type: 'casual', start: '2026-11-09', end: '2026-11-10', reason: 'x',
    });

    const res = await request(app).delete('/api/v1/leaves/types/casual').set(as(hr));
    expect(res.status).toBe(200);
    expect(res.body.retired).toBe(true);

    // The type still exists, so the request that used it still makes sense.
    const stored = await LeaveType.findOne({ company: COMPANY, code: 'casual' });
    expect(stored).toBeTruthy();
    expect(stored.active).toBe(false);
    expect(await Leave.countDocuments({ company: COMPANY, type: 'casual' })).toBe(1);
  });
});

describe('who may configure leave policy', () => {
  it('refuses an ordinary employee', async () => {
    const { employee } = await seed();
    expect((await request(app).post('/api/v1/leaves/types').set(as(employee)).send({ code: 'freebie', name: 'Freebie' })).status).toBe(403);
    expect((await request(app).patch('/api/v1/leaves/types/casual').set(as(employee)).send({ annualQuota: 365 })).status).toBe(403);
    expect((await request(app).delete('/api/v1/leaves/types/casual').set(as(employee))).status).toBe(403);
  });

  it('never touches another company policy', async () => {
    const { hr } = await seed();
    await LeaveType.create({ company: 'OtherCo', code: 'casual', name: 'Their Casual', annualQuota: 12 });

    await request(app).patch('/api/v1/leaves/types/casual').set(as(hr)).send({ annualQuota: 30 });

    const theirs = await LeaveType.findOne({ company: 'OtherCo', code: 'casual' });
    expect(theirs.annualQuota).toBe(12);
  });
});
