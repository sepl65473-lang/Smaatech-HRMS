// Covers the issues found in the SECOND audit pass, after the P0 work:
// mass assignment on the smaller CRUD routes, self-approval on expenses, and
// PII exposure on the asset register and candidate pipeline.
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
const Expense = (await import('../models/Expense.js')).default;
const Asset = (await import('../models/Asset.js')).default;
const Candidate = (await import('../models/Candidate.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'PassTwoCo';

async function ensureRoles() {
  const defs = {
    'HR Director': ['manageEmployees', 'manageUsers', 'managePayroll', 'manageExpenses', 'manageAssets', 'manageRecruitment'],
    'HR Manager': ['manageEmployees', 'manageRecruitment'],
    'Finance Lead': ['managePayroll', 'manageExpenses'],
    Employee: [],
  };
  for (const [name, allowedActions] of Object.entries(defs)) {
    if (!(await Role.findOne({ name }))) await Role.create({ name, allowedActions });
  }
}

async function seedUser(role, key, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key}@example.com`;
  await User.create({ name: key, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

let ctx;

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY, twoFactor: false, approvalWorkflows: { expense: ['Finance Lead', 'HR Director'] } });
  await ensureRoles();

  const financeEmp = await Employee.create({ name: 'Finance Person', dept: 'Finance', company: COMPANY });
  const worker = await Employee.create({ name: 'Worker', dept: 'Engineering', company: COMPANY });
  ctx = {
    financeEmp,
    worker,
    tokens: {
      finance: await seedUser('Finance Lead', 'finance', financeEmp._id),
      worker: await seedUser('Employee', 'worker', worker._id),
      hrDirector: await seedUser('HR Director', 'director'),
      hrManager: await seedUser('HR Manager', 'hrmgr'),
    },
  };
});

describe('expense self-approval', () => {
  it('blocks a Finance Lead approving their OWN expense claim', async () => {
    const filed = await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({ empId: String(ctx.financeEmp._id), name: 'Finance Person', category: 'Travel', amount: 25000, date: '2026-08-03', description: 'Conference' });
    expect(filed.status).toBe(201);

    const selfApprove = await request(app)
      .post(`/api/v1/expenses/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`);
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await Expense.findById(filed.body.id)).status).toBe('pending');
  });

  it('blocks self-DECLINE too', async () => {
    const filed = await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({ empId: String(ctx.financeEmp._id), name: 'Finance Person', category: 'Travel', amount: 100, date: '2026-08-03' });
    const res = await request(app)
      .post(`/api/v1/expenses/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({ reason: 'withdrawing' });
    expect(res.status).toBe(403);
  });

  it('still lets a different approver decide the claim', async () => {
    const filed = await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.tokens.worker}`)
      .send({ empId: String(ctx.worker._id), name: 'Worker', category: 'Travel', amount: 500, date: '2026-08-03' });

    const res = await request(app)
      .post(`/api/v1/expenses/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`);
    expect(res.status).toBe(200);
  });

  it('requires a reason when declining', async () => {
    const filed = await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.tokens.worker}`)
      .send({ empId: String(ctx.worker._id), name: 'Worker', category: 'Travel', amount: 500, date: '2026-08-03' });

    const res = await request(app)
      .post(`/api/v1/expenses/${filed.body.id}/decline`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
  });

  it('cannot be approved via the generic PATCH route', async () => {
    const filed = await request(app)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ctx.tokens.worker}`)
      .send({ empId: String(ctx.worker._id), name: 'Worker', category: 'Travel', amount: 500, date: '2026-08-03' });

    await request(app)
      .patch(`/api/v1/expenses/${filed.body.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({ status: 'approved', currentStage: 99, company: 'OtherCo' });

    const stored = await Expense.findById(filed.body.id);
    expect(stored.status).toBe('pending');
    expect(stored.currentStage).toBe(0);
    expect(stored.company).toBe(COMPANY);
  });
});

describe('asset register visibility', () => {
  beforeEach(async () => {
    await Asset.create({ name: 'MacBook Pro', category: 'Laptop', serialNumber: 'C02XL0ABCDEF', status: 'assigned', assignedToEmpId: ctx.worker._id, assignedToEmpName: 'Worker', company: COMPANY });
    await Asset.create({ name: 'Server Rack', category: 'Infrastructure', serialNumber: 'SR-99', company: COMPANY });
  });

  it('shows an employee only what is assigned to them', async () => {
    const res = await request(app).get('/api/v1/assets').set('Authorization', `Bearer ${ctx.tokens.worker}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].serialNumber).toBe('C02XL0ABCDEF');
  });

  it('shows HR/Finance the whole register', async () => {
    const res = await request(app).get('/api/v1/assets').set('Authorization', `Bearer ${ctx.tokens.finance}`);
    expect(res.body).toHaveLength(2);
  });

  it('cannot be moved to another tenant through a patch body', async () => {
    const asset = await Asset.findOne({ serialNumber: 'SR-99' });
    await request(app)
      .patch(`/api/v1/assets/${asset._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.finance}`)
      .send({ name: 'Renamed', company: 'OtherCo' });

    const stored = await Asset.findById(asset._id);
    expect(stored.name).toBe('Renamed');
    expect(stored.company).toBe(COMPANY);
  });
});

describe('candidate pipeline privacy', () => {
  beforeEach(async () => {
    await Candidate.create({ title: 'Senior Engineer', candidate: 'Applicant One', meta: 'applicant@example.com | +91 90000 11111', company: COMPANY });
  });

  it('returns NO candidate data to an ordinary employee', async () => {
    // Candidate records are personal data about people who do not work here.
    // The list responds 200 with an EMPTY array rather than 403, because the
    // client hydrates this collection inside a Promise.all during login and a
    // rejection there blanked the whole app (see routes/clientContract.test.js).
    // What matters for privacy is that no candidate is disclosed either way.
    const res = await request(app).get('/api/v1/recruitment').set('Authorization', `Bearer ${ctx.tokens.worker}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Applicant One');
  });

  it('still refuses a direct fetch of a candidate by id', async () => {
    // A targeted read is a deliberate act, not app bootstrap, so it refuses.
    const candidate = await Candidate.findOne({ candidate: 'Applicant One' });
    const res = await request(app).get(`/api/v1/recruitment/${candidate._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.worker}`);
    expect(res.status).toBe(403);
  });

  it('is readable by HR', async () => {
    const res = await request(app).get('/api/v1/recruitment').set('Authorization', `Bearer ${ctx.tokens.hrManager}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('cannot be moved to another tenant through a patch body', async () => {
    const candidate = await Candidate.findOne({ candidate: 'Applicant One' });
    await request(app)
      .patch(`/api/v1/recruitment/${candidate._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send({ stage: 'Interview', company: 'OtherCo' });

    const stored = await Candidate.findById(candidate._id);
    expect(stored.stage).toBe('Interview');
    expect(stored.company).toBe(COMPANY);
  });
});

describe('audit log write surface', () => {
  it('does not let a plain Employee write console-action entries', async () => {
    // Every action on the client-only allow-list is an HR/Finance console
    // operation; an Employee posting one only muddies the record an auditor
    // relies on.
    const res = await request(app)
      .post('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ctx.tokens.worker}`)
      .send({ action: 'Payroll processed', subject: 'forged entry' });
    expect(res.status).toBe(403);
  });

  it('rejects an action outside the allow-list even from HR', async () => {
    const res = await request(app)
      .post('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send({ action: 'Arbitrary forged action', subject: 'x' });
    expect(res.status).toBe(400);
  });

  it('bounds the free-text fields a client can write', async () => {
    const res = await request(app)
      .post('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send({ action: 'Employees exported', subject: 'x'.repeat(5000), details: 'y'.repeat(50000) });
    expect(res.status).toBe(201);
    expect(res.body.subject.length).toBeLessThanOrEqual(200);
    expect(res.body.details.length).toBeLessThanOrEqual(1000);
  });

  it('is readable only by an HR Director', async () => {
    const asEmployee = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${ctx.tokens.worker}`);
    expect(asEmployee.status).toBe(403);

    const asDirector = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${ctx.tokens.hrDirector}`);
    expect(asDirector.status).toBe(200);
  });
});
