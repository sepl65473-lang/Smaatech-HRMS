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

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Resignation = (await import('../models/Resignation.js')).default;
const LifecycleEvent = (await import('../models/LifecycleEvent.js')).default;

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
}, TEST_DB_HOOK_TIMEOUT);

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

describe('POST /resignations — guards on filing', () => {
  const file = (token, body) => request(app)
    .post('/api/v1/resignations').set('Authorization', `Bearer ${token}`).send(body);

  it('refuses a SECOND open resignation for the same person', async () => {
    const { employee, tokens } = await seedScenario();
    const base = {
      employeeId: employee._id, resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-08-01', reason: 'New opportunity',
    };
    expect((await file(tokens.employee, base)).status).toBe(201);

    // Without this guard each duplicate spawned its own clearance checklist
    // and its own payable F&F settlement for a single departure.
    const second = await file(tokens.employee, { ...base, reason: 'Again' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RESIGNATION_ALREADY_OPEN');
    expect(await Resignation.countDocuments({ employeeId: employee._id })).toBe(1);
  });

  it('takes the name from the employee record, not the request body', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, {
      employeeId: employee._id,
      employeeName: 'Someone Else Entirely',
      resignationDate: '2026-07-01', requestedLastWorkingDay: '2026-08-01', reason: 'x',
    });
    expect(res.status).toBe(201);
    expect(res.body.employeeName).toBe(employee.name);
  });

  it('refuses a last working day BEFORE the resignation date', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, {
      employeeId: employee._id, resignationDate: '2026-08-01',
      requestedLastWorkingDay: '2026-07-01', reason: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LAST_WORKING_DAY');
  });

  it('refuses a malformed date and a missing reason', async () => {
    const { employee, tokens } = await seedScenario();
    const bad = await file(tokens.employee, {
      employeeId: employee._id, resignationDate: '2026-07-01',
      requestedLastWorkingDay: 'next month', reason: 'x',
    });
    expect(bad.status).toBe(400);

    const noReason = await file(tokens.employee, {
      employeeId: employee._id, resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-08-01', reason: '   ',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
  });

  it('refuses a resignation for an employee in another company', async () => {
    const { tokens } = await seedScenario();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Engineer', dept: 'Eng', loc: 'Remote', company: 'SomeOtherCo',
    });
    const res = await file(tokens.hrManager, {
      employeeId: outsider._id, resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-08-01', reason: 'x',
    });
    expect(res.status).toBe(404);
    expect(await Resignation.countDocuments({ employeeId: outsider._id })).toBe(0);
  });
});

describe('POST /resignations — the notice period comes from company policy', () => {
  const file = (token, body) => request(app)
    .post('/api/v1/resignations').set('Authorization', `Bearer ${token}`).send(body);

  it('resolves the notice period from configuration and stores it with the record', async () => {
    const { employee, tokens } = await seedScenario();
    await Settings.findByIdAndUpdate(COMPANY, {
      $set: { employmentPolicy: { noticePeriodDays: 45, noticePeriodDaysOnProbation: 15, confirmedByHR: true } },
    });
    await Employee.updateOne({ _id: employee._id }, { employmentStage: 'Confirmed' });

    const res = await file(tokens.employee, {
      employeeId: employee._id,
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-09-01',
      reason: 'New opportunity',
    });
    expect(res.status).toBe(201);
    // Frozen onto the record: a later policy change must not rewrite what this
    // person was actually held to.
    expect(res.body.noticePolicyDays).toBe(45);
    expect(res.body.earliestCompliantLastWorkingDay).toBe('2026-08-15');
    expect(res.body.noticeShortfallDays).toBe(0);
  });

  it('REPORTS a short notice period rather than silently accepting it', async () => {
    const { employee, tokens } = await seedScenario();
    await Settings.findByIdAndUpdate(COMPANY, {
      $set: { employmentPolicy: { noticePeriodDays: 60, confirmedByHR: true } },
    });
    await Employee.updateOne({ _id: employee._id }, { employmentStage: 'Confirmed' });

    const res = await file(tokens.employee, {
      employeeId: employee._id,
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-07-20',
      reason: 'Personal',
    });
    // Filing still succeeds — waiving notice is an HR decision, not a
    // validation error — but the shortfall is on the record.
    expect(res.status).toBe(201);
    expect(res.body.noticeShortfallDays).toBe(41);
  });

  it('applies the PROBATION notice period to someone still on probation', async () => {
    const { employee, tokens } = await seedScenario();
    await Settings.findByIdAndUpdate(COMPANY, {
      $set: { employmentPolicy: { noticePeriodDays: 60, noticePeriodDaysOnProbation: 7, confirmedByHR: true } },
    });
    await Employee.updateOne({ _id: employee._id }, { employmentStage: 'Probation' });

    const res = await file(tokens.employee, {
      employeeId: employee._id,
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-07-15',
      reason: 'Not a fit',
    });
    expect(res.status).toBe(201);
    expect(res.body.noticePolicyDays).toBe(7);
    expect(res.body.noticeShortfallDays).toBe(0);
  });

  it('moves the employee to Notice Period and records the lifecycle event', async () => {
    const { employee, tokens } = await seedScenario();
    await file(tokens.employee, {
      employeeId: employee._id,
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-09-01',
      reason: 'New opportunity',
    });

    expect((await Employee.findById(employee._id)).employmentStage).toBe('Notice Period');
    const event = await LifecycleEvent.findOne({ empId: employee._id, type: 'notice-started' });
    expect(event).toBeTruthy();
    expect(event.effectiveDate).toBe('2026-07-01');
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
      .set('Authorization', `Bearer ${tokens.financeLead}`)
      // Clearances are still outstanding in this scenario; the explicit
      // override is the audited way past that new guard.
      .send({ overrideClearances: true });
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
      .set('Authorization', `Bearer ${tokens.hrManager}`)
      .send({ overrideClearances: true });
    expect(res.status).toBe(403);

    const stillActive = await Employee.findById(employee._id);
    expect(stillActive.status).toBe('active');
  });
});
