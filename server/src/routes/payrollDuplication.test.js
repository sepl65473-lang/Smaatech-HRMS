// Proves the duplicate-payroll guard. Before this, nothing in the schema or
// the route stopped a double-clicked "Process payroll", a retried request, or
// two concurrent admins from writing several payslips for the SAME employee
// and month — each one a real payable amount.
//
// The fix is a unique (company, empId, cycle) index enforced by the database,
// so these tests deliberately drive the concurrent path rather than only the
// sequential one: an application-level "check then insert" would pass a
// sequential test and still lose the race.
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
const Payroll = (await import('../models/Payroll.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'DupCo';
const CYCLE = '2026-08';

async function ensureRoles() {
  for (const name of ['HR Manager', 'Finance Lead', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, description: name, allowedPaths: ['/payroll'], allowedActions: name === 'Employee' ? [] : ['managePayroll'] });
    }
  }
}

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@dupco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

let emp;
let financeToken;
let employeeToken;

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
}, TEST_DB_HOOK_TIMEOUT);

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  emp = await Employee.create({
    name: 'Asha Iyer', role: 'Engineer', dept: 'Engineering', loc: 'Bengaluru',
    company: COMPANY, salary: 60000, basic: 30000, state: 'Karnataka', pan: 'ABCDE1234F', uan: '100200300400',
  });
  // The unique index is declared on the schema; in a fresh in-memory database
  // it only exists once Mongoose has built it.
  await Payroll.syncIndexes();
  financeToken = await seedUser('Finance Lead');
  employeeToken = await seedUser('Employee', emp._id);
});

function createPayroll(token, extraHeaders = {}) {
  const req = request(app)
    .post('/api/v1/payroll')
    .set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(extraHeaders)) req.set(k, v);
  return req.send({ empId: String(emp._id), name: emp.name, dept: emp.dept, cycle: CYCLE, gross: 60000, status: 'ready' });
}

describe('payroll duplicate prevention', () => {
  it('creates the first payroll row for a cycle', async () => {
    const res = await createPayroll(financeToken);
    expect(res.status).toBe(201);
    expect(res.body.cycle).toBe(CYCLE);
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id, cycle: CYCLE })).toBe(1);
  });

  it('rejects a second payroll for the same employee and cycle with 409', async () => {
    const first = await createPayroll(financeToken);
    expect(first.status).toBe(201);

    const second = await createPayroll(financeToken);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PAYROLL_ALREADY_EXISTS');
    expect(second.body.error.existingId).toBe(first.body.id);

    // The decisive assertion: still exactly one payable record.
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id, cycle: CYCLE })).toBe(1);
  });

  it('survives CONCURRENT requests — only one row is ever written', async () => {
    // Six simultaneous creates, the shape a double-click plus retries takes.
    // An application-level check-then-insert loses this race; the unique index
    // does not.
    const results = await Promise.all(Array.from({ length: 6 }, () => createPayroll(financeToken)));

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(5);
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id, cycle: CYCLE })).toBe(1);
  });

  it('replays the same response for a retry carrying the same Idempotency-Key', async () => {
    const key = 'run-2026-08-batch-17';
    const first = await createPayroll(financeToken, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);

    // A network-retried POST must not be a 409 the operator has to interpret —
    // it is the same logical request, so it succeeds with the same row.
    const retry = await createPayroll(financeToken, { 'Idempotency-Key': key });
    expect(retry.status).toBe(200);
    expect(retry.headers['x-idempotent-replay']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id, cycle: CYCLE })).toBe(1);
  });

  it('a DIFFERENT idempotency key for the same cycle is still a conflict', async () => {
    await createPayroll(financeToken, { 'Idempotency-Key': 'run-a' });
    const other = await createPayroll(financeToken, { 'Idempotency-Key': 'run-b' });
    expect(other.status).toBe(409);
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id, cycle: CYCLE })).toBe(1);
  });

  it('allows a different cycle for the same employee', async () => {
    await createPayroll(financeToken);
    const next = await request(app)
      .post('/api/v1/payroll')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ empId: String(emp._id), cycle: '2026-09', gross: 60000, status: 'ready' });
    expect(next.status).toBe(201);
    expect(await Payroll.countDocuments({ company: COMPANY, empId: emp._id })).toBe(2);
  });

  it('refuses payroll for an employee outside the caller company', async () => {
    const foreign = await Employee.create({ name: 'Outsider', company: 'OtherCo', salary: 1 });
    const res = await request(app)
      .post('/api/v1/payroll')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ empId: String(foreign._id), cycle: CYCLE, gross: 10000 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
  });
});

describe('payroll statutory computation', () => {
  it('computes real PF/PT deductions from the employee record', async () => {
    const res = await createPayroll(financeToken);
    expect(res.status).toBe(201);
    const categories = res.body.components.deductions.map((d) => d.category);
    // Basic 30,000 -> PF capped at 12% of the 15,000 ceiling = 1,800.
    const pf = res.body.components.deductions.find((d) => d.category === 'PF');
    expect(pf.amount).toBe(1800);
    // Gross 60,000 in Karnataka -> flat 200 professional tax.
    const pt = res.body.components.deductions.find((d) => d.category === 'PT');
    expect(pt.amount).toBe(200);
    // Gross 60,000/month is above the 21,000 ESI wage limit.
    expect(categories).not.toContain('ESI');
    expect(res.body.net).toBe(60000 - res.body.deductions);
  });

  it('exposes a statutory preview to Finance before committing a run', async () => {
    const res = await request(app)
      .get(`/api/v1/payroll/statutory/preview?empId=${emp._id}&cycle=${CYCLE}`)
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.detail.pf.employee).toBe(1800);
    expect(res.body.detail.tds.estimateOnly).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });

  it('does not let a plain Employee read the statutory preview', async () => {
    const res = await request(app)
      .get(`/api/v1/payroll/statutory/preview?empId=${emp._id}&cycle=${CYCLE}`)
      .set('Authorization', `Bearer ${employeeToken}`);
    expect(res.status).toBe(403);
  });
});

describe('payroll locking after disbursement', () => {
  it('locks a payslip once it is marked paid and blocks further Finance edits', async () => {
    const created = await createPayroll(financeToken);
    const paid = await request(app)
      .patch(`/api/v1/payroll/${created.body.id}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ status: 'paid' });
    expect(paid.status).toBe(200);
    expect(paid.body.lockedAt).toBeTruthy();

    const tamper = await request(app)
      .patch(`/api/v1/payroll/${created.body.id}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ net: 1 });
    expect(tamper.status).toBe(409);
    expect(tamper.body.error.code).toBe('PAYROLL_LOCKED');

    const stillPaid = await Payroll.findById(created.body.id);
    expect(stillPaid.net).not.toBe(1);
  });

  it('refuses to delete a locked payslip', async () => {
    const created = await createPayroll(financeToken);
    await request(app)
      .patch(`/api/v1/payroll/${created.body.id}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ status: 'paid' });

    const del = await request(app)
      .delete(`/api/v1/payroll/${created.body.id}`)
      .set('Authorization', `Bearer ${financeToken}`);
    expect(del.status).toBe(409);
    expect(await Payroll.countDocuments({ _id: created.body.id })).toBe(1);
  });
});

describe('payroll mass assignment', () => {
  it('cannot be moved to another company or employee through a patch body', async () => {
    const created = await createPayroll(financeToken);
    const other = await Employee.create({ name: 'Other', company: COMPANY });

    const res = await request(app)
      .patch(`/api/v1/payroll/${created.body.id}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ company: 'OtherCo', empId: String(other._id), net: 42 });
    // The closed schema strips `company` and `empId` before they reach the
    // update, so the allowed part of the patch still applies while the tenant
    // move does not. The old handler passed req.body straight into
    // findByIdAndUpdate, which would have moved the row to OtherCo.
    expect(res.status).toBe(200);
    expect(res.body.net).toBe(42);

    const row = await Payroll.findById(created.body.id);
    expect(row.company).toBe(COMPANY);
    expect(String(row.empId)).toBe(String(emp._id));
    expect(String(row.empId)).not.toBe(String(other._id));
  });

  it('a plain employee still cannot create payroll at all', async () => {
    const res = await createPayroll(employeeToken);
    expect(res.status).toBe(403);
  });
});
