// Coverage for resignations.js — the most financially/legally sensitive
// route in the app (Full & Final settlement math + the termination cascade
// that deactivates the departing employee's login), previously untested.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Resignation = (await import('../models/Resignation.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'ExitCo';

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@example.com`;
  const user = await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.accessToken, user };
}

async function seedScenario() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  const employee = await Employee.create({ name: 'Departing Employee', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY, status: 'active' });
  const employeeAuth = await seedUser('Employee', employee._id);
  const hrManager = await seedUser('HR Manager');
  const financeLead = await seedUser('Finance Lead');
  return { employee, tokens: { employee: employeeAuth.token, hrManager: hrManager.token, financeLead: financeLead.token }, employeeUserId: employeeAuth.user._id };
}

beforeAll(async () => {
  await startTestDB();
}, 60000);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

describe('POST /resignations', () => {
  it('lets an employee file their own resignation', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'New opportunity' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Submitted');
    expect(res.body.clearances).toHaveLength(4);
  });

  it('blocks an employee from filing resignation on behalf of someone else', async () => {
    const { tokens } = await seedScenario();
    const res = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: '507f1f77bcf86cd799439011', employeeName: 'Someone Else', resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('POST /resignations/:id/clearance — department-scoped sign-off', () => {
  async function fileResignation(employee, token) {
    const res = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });
    return res.body;
  }

  it('rejects a non-Finance role signing off the Finance clearance', async () => {
    const { employee, tokens } = await seedScenario();
    const resignation = await fileResignation(employee, tokens.employee);
    const res = await request(app)
      .post(`/api/v1/resignations/${resignation.id}/clearance`)
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ dept: 'Finance', status: 'Approved', notes: 'ok' });
    expect(res.status).toBe(403);
  });

  it('lets Finance Lead sign off the Finance clearance', async () => {
    const { employee, tokens } = await seedScenario();
    const resignation = await fileResignation(employee, tokens.employee);
    const res = await request(app)
      .post(`/api/v1/resignations/${resignation.id}/clearance`)
      .set('Authorization', `Bearer ${tokens.financeLead}`)
      .send({ dept: 'Finance', status: 'Approved', notes: 'All dues settled' });
    expect(res.status).toBe(200);
    const financeClearance = res.body.clearances.find((c) => c.dept === 'Finance');
    expect(financeClearance.status).toBe('Approved');
    expect(financeClearance.approvedBy).toBe('Finance Lead');
  });
});

describe('POST /resignations/:id/fnf — settlement math', () => {
  it('rejects HR Manager (not Finance/Director) from calculating FnF', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });
    const res = await request(app)
      .post(`/api/v1/resignations/${filed.body.id}/fnf`)
      .set('Authorization', `Bearer ${tokens.hrManager}`)
      .send({ monthlySalary: 50000 });
    expect(res.status).toBe(403);
  });

  it('computes net payout as (salary+encashment+gratuity+allowances) - (loans+asset+other)', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });

    const res = await request(app)
      .post(`/api/v1/resignations/${filed.body.id}/fnf`)
      .set('Authorization', `Bearer ${tokens.financeLead}`)
      .send({
        monthlySalary: 50000, leaveEncashment: 5000, gratuity: 10000, otherAllowances: 2000,
        loansDeduction: 3000, assetDeduction: 1000, otherDeductions: 500,
      });
    expect(res.status).toBe(200);
    // (50000+5000+10000+2000) - (3000+1000+500) = 67000 - 4500 = 62500
    expect(res.body.fnfSettlement.netPayout).toBe(62500);
    expect(res.body.fnfSettlement.status).toBe('Processed');
  });
});

describe('POST /resignations/:id/fnf/pay — termination cascade', () => {
  it('marks the settlement paid, exits the employee, and deactivates their login', async () => {
    const { employee, tokens, employeeUserId } = await seedScenario();
    const filed = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });
    await request(app)
      .post(`/api/v1/resignations/${filed.body.id}/fnf`)
      .set('Authorization', `Bearer ${tokens.financeLead}`)
      .send({ monthlySalary: 50000 });

    const res = await request(app)
      .post(`/api/v1/resignations/${filed.body.id}/fnf/pay`)
      .set('Authorization', `Bearer ${tokens.financeLead}`);
    expect(res.status).toBe(200);
    expect(res.body.fnfSettlement.status).toBe('Paid');
    expect(res.body.status).toBe('Approved');

    const exitedEmployee = await Employee.findById(employee._id);
    expect(exitedEmployee.status).toBe('exited');

    const deactivatedUser = await User.findById(employeeUserId);
    expect(deactivatedUser.active).toBe(false);
  });

  it('rejects a non-Finance/Director role from paying out FnF', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await request(app)
      .post('/api/v1/resignations')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ employeeId: employee._id, employeeName: employee.name, resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x' });

    const res = await request(app)
      .post(`/api/v1/resignations/${filed.body.id}/fnf/pay`)
      .set('Authorization', `Bearer ${tokens.hrManager}`);
    expect(res.status).toBe(403);

    const stillActive = await Employee.findById(employee._id);
    expect(stillActive.status).toBe('active');
  });
});
