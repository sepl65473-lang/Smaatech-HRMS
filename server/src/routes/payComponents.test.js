// VARIABLE PAY — overtime, bonus, incentive, arrears, reimbursement.
//
// Payroll previously paid a fixed gross minus statutory deductions and loss of
// pay, and nothing else, so anything variable was paid outside the system or
// not at all. The properties that matter here are that nobody values or
// approves their own money, and that an approved amount is paid exactly once.
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
const Payroll = (await import('../models/Payroll.js')).default;
const PayComponent = (await import('../models/PayComponent.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'VariableCo';
const CYCLE = '2026-08';

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

async function seedUser(role, employeeId = null, label = role) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${label.toLowerCase().replace(/\s+/g, '-')}@variableco.example.com`;
  await User.create({ name: label, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({
    _id: COMPANY,
    twoFactor: false,
    // Confirmed policy: 26 working days, 8h days, overtime at 2x.
    employmentPolicy: {
      monthlyWorkingDays: 26, dailyWorkHours: 8, overtimeMultiplier: 2,
      overtimeRequiresApproval: true, confirmedByHR: true,
    },
  });
  await ensureRoles();

  const manager = await Employee.create({
    name: 'Team Lead', role: 'Manager', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active', salary: 200000,
  });
  const emp = await Employee.create({
    name: 'Worker', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active', salary: 104000, basic: 52000,
    state: 'Karnataka', taxRegime: 'new', managerId: manager._id,
  });

  return {
    emp,
    manager,
    admin: await seedUser('HR Director', null, 'Admin'),
    hr: await seedUser('HR Manager', null, 'HR'),
    finance: await seedUser('Finance Lead', null, 'Finance'),
    managerToken: await seedUser('Employee', manager._id, 'Manager User'),
    employee: await seedUser('Employee', emp._id, 'Worker User'),
  };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
const raise = (token, body) => request(app).post('/api/v1/pay-components').set(as(token)).send(body);
const decide = (token, id, body) => request(app).post(`/api/v1/pay-components/${id}/decision`).set(as(token)).send(body);

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('overtime is valued by the server, never by the claim', () => {
  it('computes the amount from salary and the CONFIGURED multiplier', async () => {
    const { hr, emp } = await seed();
    const res = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 10 });
    expect(res.status).toBe(201);

    // 104,000 / (26 * 8) = 500/hour, at 2x for 10 hours = 10,000.
    expect(res.body.hourlyRate).toBe(500);
    expect(res.body.multiplier).toBe(2);
    expect(res.body.amount).toBe(10000);
    expect(res.body.status).toBe('pending');
  });

  it('follows a changed multiplier without any code change', async () => {
    const { admin, hr, emp } = await seed();
    await request(app).put('/api/v1/lifecycle/policy').set(as(admin))
      .send({ overtimeMultiplier: 1.5, monthlyWorkingDays: 26, dailyWorkHours: 8 });

    const res = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 10 });
    expect(res.body.multiplier).toBe(1.5);
    expect(res.body.amount).toBe(7500);
  });

  it('IGNORES an amount supplied with an overtime claim', async () => {
    const { hr, emp } = await seed();
    const res = await raise(hr, {
      empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 1, amount: 9999999,
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1000); // 500/hour at 2x for one hour
  });

  it('rejects impossible hours', async () => {
    const { hr, emp } = await seed();
    for (const hours of [0, -5, 1000, 'many']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours });
      expect(res.status, `accepted ${hours} hours`).toBe(400);
    }
  });

  it('auto-approves overtime when the company policy says approval is not required', async () => {
    const { admin, hr, emp } = await seed();
    await request(app).put('/api/v1/lifecycle/policy').set(as(admin))
      .send({ overtimeRequiresApproval: false });

    const res = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 4 });
    expect(res.body.status).toBe('approved');
  });
});

describe('who may raise, and for whom', () => {
  it('lets a MANAGER claim overtime for their own direct report', async () => {
    const { managerToken, emp } = await seed();
    const res = await raise(managerToken, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 6 });
    expect(res.status).toBe(201);
    expect(res.body.raisedBy.name).toBe('Manager User');
  });

  it('refuses a manager claiming for someone who is not their report', async () => {
    const { managerToken } = await seed();
    const stranger = await Employee.create({
      name: 'Stranger', role: 'Engineer', dept: 'Sales', loc: 'Remote', company: COMPANY, salary: 100000,
    });
    const res = await raise(managerToken, { empId: stranger._id, cycle: CYCLE, kind: 'overtime', hours: 6 });
    expect(res.status).toBe(403);
  });

  it('refuses a manager raising a BONUS — overtime is the only thing they may claim', async () => {
    const { managerToken, emp } = await seed();
    const res = await raise(managerToken, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 50000 });
    expect(res.status).toBe(403);
  });

  it('refuses an employee raising anything for themselves', async () => {
    const { employee, emp } = await seed();
    const res = await raise(employee, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 8 });
    expect(res.status).toBe(403);
    expect(await PayComponent.countDocuments()).toBe(0);
  });

  it('refuses an employee from another company', async () => {
    const { hr } = await seed();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Engineer', dept: 'Eng', loc: 'Remote', company: 'OtherCo', salary: 100000,
    });
    const res = await raise(hr, { empId: outsider._id, cycle: CYCLE, kind: 'bonus', amount: 1000 });
    expect(res.status).toBe(404);
  });
});

describe('approval', () => {
  it('lets Finance approve, and records who decided it', async () => {
    const { hr, finance, emp } = await seed();
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000, description: 'Q2 bonus' });

    const res = await decide(finance, raised.body.id, { decision: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approvedBy.role).toBe('Finance Lead');
    expect(res.body.decidedAt).toBeTruthy();
  });

  it('refuses HR Manager as an approver — raising and approving must differ', async () => {
    const { hr, emp } = await seed();
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000 });
    const res = await decide(hr, raised.body.id, { decision: 'approved' });
    expect(res.status).toBe(403);
  });

  it('refuses an approver paying THEMSELVES', async () => {
    const { finance, admin } = await seed();
    // Give the Finance Lead an employee record, then raise a bonus for them.
    const financeEmp = await Employee.create({
      name: 'Finance', role: 'Finance Lead', dept: 'Finance', loc: 'Remote', company: COMPANY, salary: 200000,
    });
    await User.updateOne({ name: 'Finance' }, { employeeId: financeEmp._id });
    const refreshed = await request(app).post('/api/v1/auth/login')
      .send({ email: 'finance@variableco.example.com', password: PASSWORD });

    const raised = await raise(admin, { empId: financeEmp._id, cycle: CYCLE, kind: 'bonus', amount: 100000 });
    const res = await decide(refreshed.body.accessToken, raised.body.id, { decision: 'approved' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(finance).toBeTruthy();
  });

  it('requires a reason to reject', async () => {
    const { hr, finance, emp } = await seed();
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000 });

    const noNote = await decide(finance, raised.body.id, { decision: 'rejected' });
    expect(noNote.status).toBe(400);

    const withNote = await decide(finance, raised.body.id, { decision: 'rejected', note: 'Not budgeted' });
    expect(withNote.status).toBe(200);
    expect(withNote.body.status).toBe('rejected');
  });

  it('decides exactly once under two simultaneous approvals', async () => {
    const { hr, finance, admin, emp } = await seed();
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'incentive', amount: 5000 });

    const results = await Promise.all([
      decide(finance, raised.body.id, { decision: 'approved' }),
      decide(admin, raised.body.id, { decision: 'rejected', note: 'no' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
  });

  it('cannot be withdrawn once decided', async () => {
    const { hr, finance, emp } = await seed();
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000 });
    await decide(finance, raised.body.id, { decision: 'approved' });

    const res = await request(app).delete(`/api/v1/pay-components/${raised.body.id}`).set(as(hr));
    expect(res.status).toBe(409);
  });
});

describe('duplicate protection', () => {
  it('refuses a second component carrying the same dedupe key', async () => {
    const { hr, emp } = await seed();
    const body = { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000, dedupeKey: 'q2-bonus:worker' };
    expect((await raise(hr, body)).status).toBe(201);
    const second = await raise(hr, body);
    expect(second.status).toBe(409);
    expect(await PayComponent.countDocuments({ kind: 'bonus' })).toBe(1);
  });

  it('survives three simultaneous submissions of the same keyed claim', async () => {
    const { hr, emp } = await seed();
    const body = { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000, dedupeKey: 'race:worker' };
    const results = await Promise.all([raise(hr, body), raise(hr, body), raise(hr, body)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await PayComponent.countDocuments({ kind: 'bonus' })).toBe(1);
  });

  it('refuses to add to a cycle that has already been PAID', async () => {
    const { hr, emp } = await seed();
    await Payroll.create({
      company: COMPANY, empId: emp._id, name: emp.name, dept: emp.dept, cycle: CYCLE,
      gross: 104000, deductions: 0, net: 104000, status: 'paid',
    });
    const res = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CYCLE_ALREADY_PAID');
  });
});

describe('the payroll run pays approved variable pay, and only that', () => {
  async function approvedBonus(tokens, emp, amount, kind = 'bonus') {
    const raised = await raise(tokens.hr, { empId: emp._id, cycle: CYCLE, kind, amount });
    await decide(tokens.finance, raised.body.id, { decision: 'approved' });
    return raised.body;
  }

  it('adds approved earnings to gross and itemises them on the payslip', async () => {
    const tokens = await seed();
    const { emp, finance } = tokens;
    await approvedBonus(tokens, emp, 25000);

    const run = await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });
    expect(run.status).toBe(201);
    expect(run.body.variablePayIncluded).toBe(25000);

    const row = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    expect(row.gross).toBe(104000 + 25000);
    // The bonus is a line of its own, not folded invisibly into gross.
    const names = row.components.earnings.map((e) => e.name);
    expect(names).toContain('Gross Earnings');
    expect(row.components.earnings.find((e) => e.amount === 25000)).toBeTruthy();
  });

  it('itemises overtime with the hours and multiplier behind it', async () => {
    const tokens = await seed();
    const { emp, hr, finance } = tokens;
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'overtime', hours: 6 });
    await decide(finance, raised.body.id, { decision: 'approved' });

    await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });

    const row = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    const line = row.components.earnings.find((e) => e.name.startsWith('Overtime'));
    expect(line.name).toBe('Overtime (6h @ 2x)');
    expect(line.amount).toBe(6000);
  });

  it('subtracts an approved ad-hoc deduction', async () => {
    const tokens = await seed();
    const { emp, finance } = tokens;
    await approvedBonus(tokens, emp, 4000, 'advance-recovery');

    await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });

    const row = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    expect(row.components.deductions.some((d) => d.amount === 4000)).toBe(true);
    expect(row.net).toBe(row.gross - row.deductions);
  });

  it('does NOT pay a component that is still awaiting approval, and says so', async () => {
    const tokens = await seed();
    const { emp, hr, finance } = tokens;
    await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 50000 });

    const run = await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });
    expect(run.body.variablePayIncluded).toBe(0);
    // Silence would be indistinguishable from "there was no overtime".
    expect(run.body.pendingComponentsNotPaid).toBe(1);

    const row = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    expect(row.gross).toBe(104000);
  });

  it('does not pay a REJECTED component', async () => {
    const tokens = await seed();
    const { emp, hr, finance } = tokens;
    const raised = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 50000 });
    await decide(finance, raised.body.id, { decision: 'rejected', note: 'Not budgeted' });

    const run = await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });
    expect(run.body.variablePayIncluded).toBe(0);
  });

  it('pays an approved component exactly ONCE, even across cycles', async () => {
    const tokens = await seed();
    const { emp, finance } = tokens;
    const bonus = await approvedBonus(tokens, emp, 25000);

    await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });

    // It is now bound to that payslip.
    const bound = await PayComponent.findById(bonus.id);
    expect(bound.payrollId).toBeTruthy();

    // Running the NEXT cycle must not pick it up again.
    const next = await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: '2026-09' });
    expect(next.body.variablePayIncluded).toBe(0);
    const nextRow = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: '2026-09' });
    expect(nextRow.gross).toBe(104000);
  });

  it('closes the component out when the payslip is disbursed', async () => {
    const tokens = await seed();
    const { emp, finance } = tokens;
    const bonus = await approvedBonus(tokens, emp, 25000);
    await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });

    const row = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    await request(app).patch(`/api/v1/payroll/${row._id}`).set(as(finance)).send({ status: 'paid' });

    expect((await PayComponent.findById(bonus.id)).status).toBe('paid');
  });

  it('computes statutory deductions on the contractual gross, not the bonus-inflated one', async () => {
    const tokens = await seed();
    const { emp, finance } = tokens;

    const withoutBonus = await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: '2026-07' });
    expect(withoutBonus.status).toBe(201);
    const baseRow = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: '2026-07' });
    const basePF = baseRow.components.deductions.find((d) => d.category === 'PF')?.amount;

    await approvedBonus(tokens, emp, 100000);
    await request(app).post('/api/v1/payroll/run').set(as(finance)).send({ cycle: CYCLE });
    const bonusRow = await Payroll.findOne({ company: COMPANY, empId: emp._id, cycle: CYCLE });
    const bonusPF = bonusRow.components.deductions.find((d) => d.category === 'PF')?.amount;

    // A one-off bonus is not a raise; PF must not move because of it.
    expect(bonusPF).toBe(basePF);
  });
});

describe('visibility', () => {
  it('shows an employee their own components and nobody else\'s', async () => {
    const tokens = await seed();
    const { hr, emp, employee } = tokens;
    const stranger = await Employee.create({
      name: 'Stranger', role: 'Engineer', dept: 'Sales', loc: 'Remote', company: COMPANY, salary: 100000,
    });
    await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 1000 });
    await raise(hr, { empId: stranger._id, cycle: CYCLE, kind: 'bonus', amount: 90000 });

    const res = await request(app).get('/api/v1/pay-components').set(as(employee));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(String(res.body[0].empId)).toBe(String(emp._id));
  });

  it('shows a manager their own plus their reports', async () => {
    const tokens = await seed();
    const { hr, emp, managerToken } = tokens;
    await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 1000 });

    const res = await request(app).get('/api/v1/pay-components').set(as(managerToken));
    expect(res.body.some((c) => String(c.empId) === String(emp._id))).toBe(true);
  });

  it('summarises a cycle for Finance, separating approved from pending', async () => {
    const tokens = await seed();
    const { hr, finance, emp } = tokens;
    const approved = await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'bonus', amount: 25000 });
    await decide(finance, approved.body.id, { decision: 'approved' });
    await raise(hr, { empId: emp._id, cycle: CYCLE, kind: 'incentive', amount: 7000 });

    const res = await request(app).get(`/api/v1/pay-components/summary?cycle=${CYCLE}`).set(as(finance));
    expect(res.status).toBe(200);
    expect(res.body.approvedEarnings).toBe(25000);
    expect(res.body.pendingTotal).toBe(7000);
    expect(res.body.pendingCount).toBe(1);
  });

  it('refuses the cycle summary to an ordinary employee', async () => {
    const { employee } = await seed();
    const res = await request(app).get(`/api/v1/pay-components/summary?cycle=${CYCLE}`).set(as(employee));
    expect(res.status).toBe(403);
  });
});
