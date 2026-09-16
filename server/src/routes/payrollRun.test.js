// POST /payroll/run — running payroll for a whole cycle.
//
// Before this endpoint existed, a payslip row was only ever created as a side
// effect of creating an employee, so the register was silently incomplete for
// anyone hired in an earlier cycle and there was no way to produce one.
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
const Payroll = (await import('../models/Payroll.js')).default;
const Role = (await import('../models/Role.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'RunCo';
const CYCLE = '2026-08';

async function ensureRoles() {
  // requireRole() resolves capability from the Role documents, not from the
  // JWT's role name — so 'Employee' must be seeded WITHOUT managePayroll,
  // exactly as a real tenant has it.
  const roles = [
    { name: 'HR Manager', allowedPaths: ['/payroll'], allowedActions: ['managePayroll'] },
    { name: 'Finance Lead', allowedPaths: ['/payroll'], allowedActions: ['managePayroll'] },
    { name: 'Employee', allowedPaths: ['/'], allowedActions: [] },
  ];
  for (const role of roles) {
    if (!(await Role.findOne({ name: role.name }))) {
      await Role.create({ description: role.name, ...role });
    }
  }
}

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@runco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  const paid = await Employee.create({
    name: 'Paid Person', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, salary: 120000, basic: 60000, state: 'Karnataka', taxRegime: 'new',
  });
  const alsoPaid = await Employee.create({
    name: 'Second Person', role: 'Analyst', dept: 'Finance', loc: 'Remote',
    company: COMPANY, salary: 40000, basic: 20000, state: 'Karnataka', taxRegime: 'new',
  });
  const noSalary = await Employee.create({
    name: 'No Salary Person', role: 'Intern', dept: 'Engineering', loc: 'Remote', company: COMPANY,
  });
  return {
    paid,
    alsoPaid,
    noSalary,
    finance: await seedUser('Finance Lead'),
    hr: await seedUser('HR Manager'),
    employee: await seedUser('Employee', paid._id),
  };
}

const run = (token, body = { cycle: CYCLE }) => request(app)
  .post('/api/v1/payroll/run').set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('running a cycle', () => {
  it('creates one row per payable employee, with server-derived figures', async () => {
    const { finance, paid, alsoPaid, noSalary } = await seed();

    const res = await run(finance);
    expect(res.status).toBe(201);
    expect(res.body.cycle).toBe(CYCLE);
    expect(res.body.created).toBe(2);

    const rows = await Payroll.find({ company: COMPANY, cycle: CYCLE }).sort({ name: 1 });
    expect(rows.map((r) => String(r.empId)).sort())
      .toEqual([String(paid._id), String(alsoPaid._id)].sort());

    const row = rows.find((r) => String(r.empId) === String(paid._id));
    expect(row.gross).toBe(120000);
    expect(row.status).toBe('ready');
    // Statutory deductions were computed, not left at zero.
    expect(row.deductions).toBeGreaterThan(0);
    expect(row.net).toBe(row.gross - row.deductions);
    expect(row.components.deductions.length).toBeGreaterThan(0);

    // The employee it could not pay is REPORTED, not silently dropped.
    expect(res.body.unpayable).toHaveLength(1);
    expect(res.body.unpayable[0].name).toBe(noSalary.name);
    expect(res.body.unpayable[0].reason).toBe('NO_SALARY_ON_FILE');
  });

  it('is idempotent — a second run creates nothing and changes nothing', async () => {
    const { finance } = await seed();
    await run(finance);
    const before = await Payroll.find({ company: COMPANY, cycle: CYCLE }).sort({ name: 1 }).lean();

    const second = await run(finance);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBe(2);

    const after = await Payroll.find({ company: COMPANY, cycle: CYCLE }).sort({ name: 1 }).lean();
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => String(r._id))).toEqual(before.map((r) => String(r._id)));
  });

  it('never overwrites a row Finance has already corrected or paid', async () => {
    const { finance, paid } = await seed();
    await run(finance);

    const row = await Payroll.findOne({ company: COMPANY, cycle: CYCLE, empId: paid._id });
    await Payroll.updateOne({ _id: row._id }, { status: 'paid', net: 1234, gross: 5678 });

    await run(finance);

    const after = await Payroll.findOne({ _id: row._id });
    expect(after.status).toBe('paid');
    expect(after.net).toBe(1234);
    expect(after.gross).toBe(5678);
  });

  it('survives concurrent runs without duplicating anyone', async () => {
    const { finance, hr } = await seed();

    const results = await Promise.all([run(finance), run(hr), run(finance)]);
    for (const res of results) expect([200, 201]).toContain(res.status);

    const rows = await Payroll.find({ company: COMPANY, cycle: CYCLE });
    expect(rows).toHaveLength(2);
    const totalCreated = results.reduce((sum, r) => sum + r.body.created, 0);
    expect(totalCreated).toBe(2);
  });

  it('records the run in the audit trail', async () => {
    const { finance } = await seed();
    await run(finance);
    const log = await AuditLog.findOne({ action: 'Payroll run' });
    expect(log).toBeTruthy();
    expect(log.subject).toBe(CYCLE);
  });
});

describe('who may run payroll', () => {
  it('refuses an ordinary employee', async () => {
    const { employee } = await seed();
    const res = await run(employee);
    expect(res.status).toBe(403);
    expect(await Payroll.countDocuments({ company: COMPANY, cycle: CYCLE })).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    await seed();
    const res = await request(app).post('/api/v1/payroll/run').send({ cycle: CYCLE });
    expect(res.status).toBe(401);
  });
});

describe('input handling', () => {
  it('rejects a malformed cycle', async () => {
    const { finance } = await seed();
    for (const cycle of ['2026', 'August', '2026-13', '2026-1']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await run(finance, { cycle });
      expect(res.status, `accepted "${cycle}"`).toBe(400);
    }
  });

  it('ignores any figures the caller tries to supply', async () => {
    const { finance } = await seed();
    const res = await run(finance, { cycle: CYCLE, gross: 99999999, net: 99999999 });
    // Closed schema: the extra keys are stripped or rejected, never applied.
    expect([200, 201, 400]).toContain(res.status);
    const rows = await Payroll.find({ company: COMPANY, cycle: CYCLE });
    for (const row of rows) expect(row.gross).not.toBe(99999999);
  });

  it('does not touch another company register', async () => {
    const { finance } = await seed();
    const otherEmp = await Employee.create({
      name: 'Other Co Person', role: 'Engineer', dept: 'Eng', loc: 'Remote',
      company: 'SomeOtherCo', salary: 100000,
    });
    await run(finance);
    expect(await Payroll.countDocuments({ empId: otherEmp._id })).toBe(0);
  });
});
