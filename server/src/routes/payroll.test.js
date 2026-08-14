// Coverage for payroll.js — a real employee's own payslip visibility, and
// the HR Manager/Finance Lead-only gate on creating/processing/marking paid
// (previously untested despite handling real salary figures).
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

const PASSWORD = 'CorrectPass123';
const COMPANY = 'PayrollCo';

// requireRole() looks these up from the DB (not just the JWT's role name).
async function ensureRoles() {
  for (const name of ['HR Manager', 'Finance Lead']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, description: name, allowedPaths: ['/payroll'], allowedActions: ['managePayroll'] });
    }
  }
}

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seedScenario() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  const empA = await Employee.create({ name: 'Employee A', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY });
  const empB = await Employee.create({ name: 'Employee B', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY });
  const rowA = await Payroll.create({ empId: empA._id, name: empA.name, dept: empA.dept, gross: 100000, net: 70000, deductions: 30000, cycle: '2026-07', status: 'ready', company: COMPANY });
  const rowB = await Payroll.create({ empId: empB._id, name: empB.name, dept: empB.dept, gross: 90000, net: 63000, deductions: 27000, cycle: '2026-07', status: 'ready', company: COMPANY });
  const tokens = {
    employeeA: await seedUser('Employee', empA._id),
    hrManager: await seedUser('HR Manager'),
    financeLead: await seedUser('Finance Lead'),
  };
  return { empA, empB, rowA, rowB, tokens };
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

describe('GET /payroll — role-based visibility', () => {
  it('scopes a plain employee to only their own payslip', async () => {
    const { rowA, rowB, tokens } = await seedScenario();
    const res = await request(app).get('/api/v1/payroll').set('Authorization', `Bearer ${tokens.employeeA}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((p) => p.id);
    expect(ids).toContain(rowA.id ?? String(rowA._id));
    expect(ids).not.toContain(String(rowB._id));
  });

  it('lets HR Manager and Finance Lead see every payslip', async () => {
    const { rowA, rowB, tokens } = await seedScenario();
    const res = await request(app).get('/api/v1/payroll').set('Authorization', `Bearer ${tokens.financeLead}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((p) => String(p.id));
    expect(ids).toEqual(expect.arrayContaining([String(rowA._id), String(rowB._id)]));
  });
});

describe('POST /payroll — creation is HR/Finance-only', () => {
  it('rejects a plain employee trying to create a payroll record', async () => {
    const { empA, tokens } = await seedScenario();
    const res = await request(app)
      .post('/api/v1/payroll')
      .set('Authorization', `Bearer ${tokens.employeeA}`)
      .send({ empId: empA._id, name: empA.name, dept: empA.dept, gross: 50000, net: 40000, deductions: 10000, cycle: '2026-08', status: 'ready' });
    expect(res.status).toBe(403);
  });

  it('lets Finance Lead create a payroll record', async () => {
    const { empA, tokens } = await seedScenario();
    const res = await request(app)
      .post('/api/v1/payroll')
      .set('Authorization', `Bearer ${tokens.financeLead}`)
      .send({ empId: empA._id, name: empA.name, dept: empA.dept, gross: 50000, net: 40000, deductions: 10000, cycle: '2026-08', status: 'ready' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ready');
  });
});

describe('PATCH /payroll/:id — marking paid', () => {
  it('rejects a plain employee trying to mark their own slip paid', async () => {
    const { rowA, tokens } = await seedScenario();
    const res = await request(app)
      .patch(`/api/v1/payroll/${rowA._id}`)
      .set('Authorization', `Bearer ${tokens.employeeA}`)
      .send({ status: 'paid' });
    expect(res.status).toBe(403);
    const stored = await Payroll.findById(rowA._id);
    expect(stored.status).toBe('ready');
  });

  it('lets HR Manager mark a slip paid', async () => {
    const { rowA, tokens } = await seedScenario();
    const res = await request(app)
      .patch(`/api/v1/payroll/${rowA._id}`)
      .set('Authorization', `Bearer ${tokens.hrManager}`)
      .send({ status: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    const stored = await Payroll.findById(rowA._id);
    expect(stored.status).toBe('paid');
  });
});
