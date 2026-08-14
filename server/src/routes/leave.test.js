// Coverage for leave.js's stage-based approval workflow — previously
// completely untested despite being real, multi-step business logic (an
// approval only actually finalizes once every configured stage has signed
// off, and the wrong role at a given stage must be rejected).
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
const Leave = (await import('../models/Leave.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'LeaveCo';

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seedScenario() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  const employee = await Employee.create({ name: 'Requesting Employee', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY });
  const tokens = {
    employee: await seedUser('Employee', employee._id),
    hrManager: await seedUser('HR Manager'),
    hrDirector: await seedUser('HR Director'),
    financeLead: await seedUser('Finance Lead'),
  };
  return { employee, tokens };
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

describe('POST /leave', () => {
  it('lets an employee self-file their own leave, defaulting to pending at stage 0', async () => {
    const { employee, tokens } = await seedScenario();
    const res = await request(app)
      .post('/api/v1/leaves')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ empId: String(employee._id), name: 'Requesting Employee', dept: 'Engineering', type: 'casual', start: '2026-08-01', end: '2026-08-02', reason: 'Trip' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.currentStage).toBe(0);
    expect(res.body.approvalStages).toEqual(['HR Manager', 'HR Director']);
  });

  it('blocks an employee from filing leave on behalf of someone else', async () => {
    const { tokens } = await seedScenario();
    const otherEmpId = '507f1f77bcf86cd799439011';
    const res = await request(app)
      .post('/api/v1/leaves')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ empId: otherEmpId, name: 'Someone Else', dept: 'Engineering', type: 'casual', start: '2026-08-01', end: '2026-08-02' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /leave/:id/approve and /decline — stage-based workflow', () => {
  async function fileLeave(tokens, employee) {
    const res = await request(app)
      .post('/api/v1/leaves')
      .set('Authorization', `Bearer ${tokens.employee}`)
      .send({ empId: String(employee._id), name: 'Requesting Employee', dept: 'Engineering', type: 'casual', start: '2026-08-01', end: '2026-08-02' });
    return res.body;
  }

  it('rejects the wrong role for the current stage', async () => {
    const { employee, tokens } = await seedScenario();
    const leave = await fileLeave(tokens, employee);

    // Stage 0 requires HR Manager — Finance Lead must not be able to approve it.
    const res = await request(app)
      .post(`/api/v1/leaves/${leave.id}/approve`)
      .set('Authorization', `Bearer ${tokens.financeLead}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const stillPending = await Leave.findById(leave.id);
    expect(stillPending.currentStage).toBe(0);
    expect(stillPending.status).toBe('pending');
  });

  it('only finalizes to approved once every stage has signed off', async () => {
    const { employee, tokens } = await seedScenario();
    const leave = await fileLeave(tokens, employee);

    const stage0 = await request(app)
      .post(`/api/v1/leaves/${leave.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`);
    expect(stage0.status).toBe(200);
    expect(stage0.body.status).toBe('pending'); // one more stage to go
    expect(stage0.body.currentStage).toBe(1);

    const stage1 = await request(app)
      .post(`/api/v1/leaves/${leave.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrDirector}`);
    expect(stage1.status).toBe(200);
    expect(stage1.body.status).toBe('approved');
    expect(stage1.body.approvals).toHaveLength(2);
  });

  it('rejects approving/declining an already-decided request', async () => {
    const { employee, tokens } = await seedScenario();
    const leave = await fileLeave(tokens, employee);
    await request(app).post(`/api/v1/leaves/${leave.id}/decline`).set('Authorization', `Bearer ${tokens.hrManager}`);

    const res = await request(app)
      .post(`/api/v1/leaves/${leave.id}/approve`)
      .set('Authorization', `Bearer ${tokens.hrManager}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ALREADY_DECIDED');
  });

  it('decline finalizes immediately regardless of stage', async () => {
    const { employee, tokens } = await seedScenario();
    const leave = await fileLeave(tokens, employee);

    const res = await request(app)
      .post(`/api/v1/leaves/${leave.id}/decline`)
      .set('Authorization', `Bearer ${tokens.hrManager}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');

    const stored = await Leave.findById(leave.id);
    expect(stored.status).toBe('declined');
  });
});
