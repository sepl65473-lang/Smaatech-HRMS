// Leave workflow coverage.
//
// The previous version of this file used 2026-08-01/02 — a Saturday and a
// Sunday — and still expected a successful 2-day leave, which the old code
// happily created with workingDays: 0. Dates here are real weekdays.
//
// New ground covered: the server-side balance (which did not exist at all),
// reporting-manager routing and team scoping, self-approval, mandatory
// decline reasons, holiday exclusion, and concurrent filing.
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
const Leave = (await import('../models/Leave.js')).default;
const LeaveBalance = (await import('../models/LeaveBalance.js')).default;
const LeaveLedger = (await import('../models/LeaveLedger.js')).default;
const LeaveType = (await import('../models/LeaveType.js')).default;
const Holiday = (await import('../models/Holiday.js')).default;
const Role = (await import('../models/Role.js')).default;
const { reconcile } = await import('../lib/leaveLedger.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'LeaveCo';

// Mon 3 Aug 2026 - Fri 7 Aug 2026 is a clean 5-working-day week.
const MON = '2026-08-03';
const TUE = '2026-08-04';
const WED = '2026-08-05';
const FRI = '2026-08-07';
const NEXT_MON = '2026-08-10';
const NEXT_TUE = '2026-08-11';

async function ensureRoles() {
  for (const name of ['HR Manager', 'HR Director', 'Finance Lead', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, allowedPaths: ['/leave'], allowedActions: ['HR Manager', 'HR Director'].includes(name) ? ['manageLeave'] : [] });
    }
  }
}

async function seedUser(role, employeeId = null, emailKey = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${emailKey || role.toLowerCase().replace(/\s+/g, '-')}@example.com`;
  await User.create({ name: emailKey || role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seedScenario({ stages = ['HR Manager', 'HR Director'] } = {}) {
  await Settings.create({ _id: COMPANY, twoFactor: false, approvalWorkflows: { leave: stages } });
  await ensureRoles();
  const manager = await Employee.create({ name: 'Team Manager', role: 'Manager', dept: 'Engineering', company: COMPANY });
  const employee = await Employee.create({ name: 'Requesting Employee', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY, managerId: manager._id });
  const outsider = await Employee.create({ name: 'Other Team', role: 'Engineer', dept: 'Sales', company: COMPANY });
  await LeaveBalance.syncIndexes();
  const tokens = {
    employee: await seedUser('Employee', employee._id, 'requester'),
    manager: await seedUser('Employee', manager._id, 'manager'),
    outsider: await seedUser('Employee', outsider._id, 'outsider'),
    hrManager: await seedUser('HR Manager'),
    hrDirector: await seedUser('HR Director'),
    financeLead: await seedUser('Finance Lead'),
  };
  return { employee, manager, outsider, tokens };
}

function file(token, body) {
  return request(app).post('/api/v1/leaves').set('Authorization', `Bearer ${token}`).send(body);
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

describe('filing leave', () => {
  it('lets an employee self-file, defaulting to pending at stage 0', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE, reason: 'Trip' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.currentStage).toBe(0);
    expect(res.body.workingDays).toBe(2);
    expect(res.body.approvalStages).toEqual(['HR Manager', 'HR Director']);
  });

  it('blocks filing on behalf of someone else', async () => {
    const { outsider, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(outsider._id), type: 'casual', start: MON, end: TUE });
    expect(res.status).toBe(403);
  });

  it('takes name and dept from the employee record, not the request body', async () => {
    // Otherwise a request can carry a different person's name into approvals,
    // notifications and the audit trail.
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, {
      empId: String(employee._id), type: 'casual', start: MON, end: TUE,
      name: 'Someone Important', dept: 'Board',
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Requesting Employee');
    expect(res.body.dept).toBe('Engineering');
  });

  it('rejects an end date before the start date', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: FRI, end: MON });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RANGE');
  });

  it('rejects a range that is entirely weekend', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: '2026-08-01', end: '2026-08-02' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_WORKING_DAYS');
  });

  it('rejects an unconfigured leave type', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'sabbatical', start: MON, end: TUE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNKNOWN_LEAVE_TYPE');
  });

  it('rejects an overlapping request with 409', async () => {
    const { employee, tokens } = await seedScenario();
    await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: WED });
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: TUE, end: FRI });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_LEAVE');
  });
});

describe('holiday handling in working-day calculation', () => {
  it('excludes a company holiday falling inside the leave range', async () => {
    // The old code built its holiday set straight from Holiday.date display
    // strings ("5 Aug, Wed") and compared them to ISO dates, so no holiday
    // ever matched and employees were charged leave for company holidays.
    const { employee, tokens } = await seedScenario();
    await Holiday.create({ name: 'Founders Day', date: '5 Aug, Wed', company: COMPANY });

    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: FRI });
    expect(res.status).toBe(201);
    // Mon-Fri is 5 weekdays; Wednesday is a company holiday, so 4 are charged.
    expect(res.body.workingDays).toBe(4);
  });

  it('does not count weekends', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: NEXT_TUE });
    expect(res.status).toBe(201);
    // Mon 3 -> Tue 11 spans 9 calendar days, 2 of them a weekend.
    expect(res.body.workingDays).toBe(7);
  });
});

describe('server-side leave balance', () => {
  it('exposes a computed balance sheet the client never has to derive', async () => {
    const { tokens } = await seedScenario();
    const res = await request(app).get('/api/v1/leaves/balance').set('Authorization', `Bearer ${tokens.employee}`);
    expect(res.status).toBe(200);
    const casual = res.body.balances.find((b) => b.type === 'casual');
    expect(casual).toBeDefined();
    expect(casual.annualQuota).toBe(12);
    expect(casual.balanceTracked).toBe(true);
    const unpaid = res.body.balances.find((b) => b.type === 'unpaid');
    expect(unpaid.balanceTracked).toBe(false);
  });

  it('reserves days at FILING time, not at approval', async () => {
    // Reserving only at approval lets an employee file the same last days
    // several times over and have them all approved later.
    const { employee, tokens } = await seedScenario();
    await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.pending).toBe(2);
    expect(balance.used).toBe(0);
  });

  it('REJECTS a request that exceeds the remaining balance', async () => {
    const { employee, tokens } = await seedScenario();
    // Cap casual leave at 2 days to make the boundary explicit.
    await LeaveType.findOneAndUpdate({ company: COMPANY, code: 'casual' }, { annualQuota: 2, accrualMode: 'annual' }, { upsert: true });

    const ok = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    expect(ok.status).toBe(201);

    const over = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: NEXT_MON, end: NEXT_TUE });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(over.body.error.available).toBe(0);

    // The rejected request must not be left behind as a phantom row.
    expect(await Leave.countDocuments({ company: COMPANY, empId: employee._id })).toBe(1);
  });

  it('never blocks UNPAID leave on balance', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await file(tokens.employee, { empId: String(employee._id), type: 'unpaid', start: MON, end: FRI });
    expect(res.status).toBe(201);
    expect(res.body.workingDays).toBe(5);
  });

  it('returns the days when a request is declined', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const before = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(before.pending).toBe(2);

    const declined = await request(app)
      .post(`/api/v1/leaves/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${tokens.hrManager}`)
      .send({ note: 'Team is short-staffed that week' });
    expect(declined.status).toBe(200);

    const after = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(after.pending).toBe(0);
    expect(after.used).toBe(0);
    expect(after.available).toBe(before.available + 2);
  });

  it('moves days from pending to used on final approval', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});

    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.pending).toBe(0);
    expect(balance.used).toBe(2);
  });

  it('returns days when an APPROVED leave is later cancelled', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});

    const cancelled = await request(app).post(`/api/v1/leaves/${filed.body.id}/withdraw`)
      .set('Authorization', `Bearer ${tokens.employee}`).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.used).toBe(0);
  });

  it('holds up under CONCURRENT filings against the last remaining days', async () => {
    const { employee, tokens } = await seedScenario();
    await LeaveType.findOneAndUpdate({ company: COMPANY, code: 'casual' }, { annualQuota: 2, accrualMode: 'annual' }, { upsert: true });

    // Four simultaneous non-overlapping 2-day requests against a 2-day
    // balance. A read-then-write balance check would let several through.
    const ranges = [[MON, TUE], [NEXT_MON, NEXT_TUE], ['2026-08-17', '2026-08-18'], ['2026-08-24', '2026-08-25']];
    const results = await Promise.all(ranges.map(([start, end]) => file(tokens.employee, {
      empId: String(employee._id), type: 'casual', start, end,
    })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);

    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.pending).toBe(2);
    expect(balance.available).toBe(0);
  });

  it('writes an auditable ledger entry for every movement', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});

    const entries = await LeaveLedger.find({ company: COMPANY, empId: employee._id, type: 'casual' }).sort({ createdAt: 1 });
    const reasons = entries.map((e) => e.reason);
    expect(reasons).toContain('leave-applied');
    expect(reasons).toContain('leave-approved');
    // Every movement names who caused it.
    expect(entries.every((e) => e.actor && e.actor.name)).toBe(true);

    const check = await reconcile({ company: COMPANY, empId: employee._id, year: 2026, type: 'casual' });
    expect(check.matches).toBe(true);
  });
});

describe('approval workflow', () => {
  it('rejects the wrong role for the current stage', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.financeLead}`).send({});
    expect(res.status).toBe(403);
  });

  it('only finalises once every stage has signed off', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const stage1 = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});
    expect(stage1.status).toBe(200);
    expect(stage1.body.status).toBe('pending');
    expect(stage1.body.currentStage).toBe(1);

    const stage2 = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrDirector}`).send({});
    expect(stage2.status).toBe(200);
    expect(stage2.body.status).toBe('approved');
  });

  it('rejects deciding an already-decided request', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});

    const again = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
  });

  it('records who decided, not just which role', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    const approved = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({ note: 'Fine by me' });

    expect(approved.body.approvals[0].by).toBe('HR Manager');
    expect(approved.body.approvals[0].note).toBe('Fine by me');
    expect(approved.body.approvals[0].byId).toBeTruthy();
  });

  it('survives two approvers clicking at the same moment', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const results = await Promise.all([
      request(app).post(`/api/v1/leaves/${filed.body.id}/approve`).set('Authorization', `Bearer ${tokens.hrManager}`).send({}),
      request(app).post(`/api/v1/leaves/${filed.body.id}/approve`).set('Authorization', `Bearer ${tokens.hrDirector}`).send({}),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const stored = await Leave.findById(filed.body.id);
    expect(stored.approvals).toHaveLength(1);
    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.used).toBe(2);
  });
});

describe('self-approval is blocked', () => {
  it('stops an HR Manager approving their OWN leave request', async () => {
    // Previously an HR Manager satisfied the 'HR Manager' stage themselves and
    // could approve their own request in a single click.
    await Settings.create({ _id: COMPANY, twoFactor: false, approvalWorkflows: { leave: ['HR Manager', 'HR Director'] } });
    await ensureRoles();
    const hrEmp = await Employee.create({ name: 'HR Person', role: 'HR Manager', dept: 'HR', company: COMPANY });
    const hrToken = await seedUser('HR Manager', hrEmp._id, 'hr-self');

    const filed = await file(hrToken, { empId: String(hrEmp._id), type: 'casual', start: MON, end: TUE });
    expect(filed.status).toBe(201);

    const selfApprove = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${hrToken}`).send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    expect((await Leave.findById(filed.body.id)).status).toBe('pending');
  });

  it('stops an HR Director approving their OWN leave request', async () => {
    await Settings.create({ _id: COMPANY, twoFactor: false, approvalWorkflows: { leave: ['HR Manager'] } });
    await ensureRoles();
    const dirEmp = await Employee.create({ name: 'Director', role: 'HR Director', dept: 'HR', company: COMPANY });
    const dirToken = await seedUser('HR Director', dirEmp._id, 'dir-self');

    const filed = await file(dirToken, { empId: String(dirEmp._id), type: 'casual', start: MON, end: TUE });
    const selfApprove = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${dirToken}`).send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('stops self-DECLINING too', async () => {
    await Settings.create({ _id: COMPANY, twoFactor: false, approvalWorkflows: { leave: ['HR Manager'] } });
    await ensureRoles();
    const hrEmp = await Employee.create({ name: 'HR Person', role: 'HR Manager', dept: 'HR', company: COMPANY });
    const hrToken = await seedUser('HR Manager', hrEmp._id, 'hr-self2');
    const filed = await file(hrToken, { empId: String(hrEmp._id), type: 'casual', start: MON, end: TUE });

    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${hrToken}`).send({ note: 'changed my mind' });
    expect(res.status).toBe(403);
  });
});

describe('reporting-manager stage', () => {
  it("lets the employee's OWN manager approve the manager stage", async () => {
    const { employee, tokens } = await seedScenario({ stages: ['Reporting Manager', 'HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.manager}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.currentStage).toBe(1);
    expect(res.body.approvals[0].role).toBe('Reporting Manager');
  });

  it('blocks a manager from OUTSIDE the team', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['Reporting Manager', 'HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.outsider}`).send({});
    expect(res.status).toBe(403);
  });

  it('lets HR act as a fallback so a request is never stuck', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['Reporting Manager'] });
    await Employee.findByIdAndUpdate(employee._id, { managerId: null });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  it('shows a manager their team requests but not other teams', async () => {
    const { employee, outsider, tokens } = await seedScenario({ stages: ['Reporting Manager'] });
    await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    await file(tokens.outsider, { empId: String(outsider._id), type: 'casual', start: MON, end: TUE });

    const list = await request(app).get('/api/v1/leaves').set('Authorization', `Bearer ${tokens.manager}`);
    expect(list.status).toBe(200);
    const empIds = list.body.map((r) => r.empId);
    expect(empIds).toContain(String(employee._id));
    expect(empIds).not.toContain(String(outsider._id));
  });

  it("lets a manager read their report's balance but not a stranger's", async () => {
    const { employee, outsider, tokens } = await seedScenario();
    const own = await request(app).get(`/api/v1/leaves/balance?empId=${employee._id}`).set('Authorization', `Bearer ${tokens.manager}`);
    expect(own.status).toBe(200);

    const other = await request(app).get(`/api/v1/leaves/balance?empId=${outsider._id}`).set('Authorization', `Bearer ${tokens.manager}`);
    expect(other.status).toBe(403);
  });
});

describe('declining', () => {
  it('accepts a decline with no body, because that is what the client sends', async () => {
    // client/src/data/store.js used to call decline(id) with no body at all.
    // Enforcing a mandatory reason at the API broke every rejection in the UI,
    // so the rule now lives where the human is: the UI prompts for a reason
    // and passes it, and the API records whatever it is given.
    // See routes/clientContract.test.js.
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    const noBody = await request(app).post(`/api/v1/leaves/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send();
    expect(noBody.status).toBe(200);
    expect(noBody.body.status).toBe('declined');
  });

  it('returns the reserved days even when no reason was given', async () => {
    // The balance must come back regardless of whether a reason was captured.
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    await request(app).post(`/api/v1/leaves/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send();

    const balance = await LeaveBalance.findOne({ company: COMPANY, empId: employee._id, type: 'casual' });
    expect(balance.pending).toBe(0);
    expect(balance.used).toBe(0);
  });

  it('stores the reason on the request', async () => {
    const { employee, tokens } = await seedScenario({ stages: ['HR Manager'] });
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${tokens.hrManager}`).send({ note: 'Release week' });
    expect(res.status).toBe(200);
    expect(res.body.declineReason).toBe('Release week');
  });
});

describe('withdrawal and HR patch', () => {
  it('lets an employee withdraw their own pending request', async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/withdraw`)
      .set('Authorization', `Bearer ${tokens.employee}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
  });

  it("blocks withdrawing someone else's request", async () => {
    const { employee, tokens } = await seedScenario();
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });
    const res = await request(app).post(`/api/v1/leaves/${filed.body.id}/withdraw`)
      .set('Authorization', `Bearer ${tokens.outsider}`).send({});
    expect(res.status).toBe(403);
  });

  it('cannot flip a request to approved through the HR patch route', async () => {
    // The old PATCH passed req.body straight into findByIdAndUpdate, so an HR
    // Manager could set status:'approved' directly, skipping every approval
    // stage, the balance deduction and the attendance marking.
    const { employee, tokens } = await seedScenario();
    const filed = await file(tokens.employee, { empId: String(employee._id), type: 'casual', start: MON, end: TUE });

    await request(app).patch(`/api/v1/leaves/${filed.body.id}`)
      .set('Authorization', `Bearer ${tokens.hrManager}`)
      .send({ status: 'approved', workingDays: 0, company: 'OtherCo' });

    const stored = await Leave.findById(filed.body.id);
    expect(stored.status).toBe('pending');
    expect(stored.workingDays).toBe(2);
    expect(stored.company).toBe(COMPANY);
  });
});
