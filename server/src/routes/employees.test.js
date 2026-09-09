// Regression test for this session's cross-tenant IDOR fix: every
// single-record employee route must be scoped by company, so a valid
// token from company B can't read/modify/delete company A's records by id.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';

async function ensureHrManagerRole() {
  // requireRole() looks this up from the DB (not just the JWT's role name),
  // so tests need the same Role fixture seed.js creates in real environments.
  const exists = await Role.findOne({ name: 'HR Manager' });
  if (!exists) {
    await Role.create({
      name: 'HR Manager',
      description: 'Manage employee directory',
      allowedPaths: ['/employees'],
      allowedActions: ['manageEmployees'],
    });
  }
}

async function seedCompany(company) {
  await Settings.create({ _id: company, twoFactor: false });
  await ensureHrManagerRole();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `hr-${company.toLowerCase()}@example.com`;
  await User.create({ name: `HR ${company}`, email, passwordHash, role: 'HR Manager', company, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
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

describe('cross-tenant isolation on /employees/:id', () => {
  it('a company-B token cannot read, edit, or delete a company-A employee by id', async () => {
    const tokenA = await seedCompany('CompanyA');
    const tokenB = await seedCompany('CompanyB');

    const created = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Real Employee', role: 'Engineer', dept: 'Engineering', loc: 'Remote' });
    expect(created.status).toBe(201);
    const empId = created.body.id;

    // Company A can see its own record — positive control.
    const ownRead = await request(app).get(`/api/v1/employees/${empId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(ownRead.status).toBe(200);
    expect(ownRead.body.name).toBe('Real Employee');

    // Company B's token gets a scoped-out null, not the real record.
    const crossRead = await request(app).get(`/api/v1/employees/${empId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(crossRead.status).toBe(200);
    expect(crossRead.body).toBeNull();

    // Company B cannot edit it either — record must remain unchanged.
    const crossPatch = await request(app)
      .patch(`/api/v1/employees/${empId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hijacked Name' });
    expect(crossPatch.status).toBe(404);

    const stillReal = await Employee.findById(empId);
    expect(stillReal.name).toBe('Real Employee');

    // Company B cannot delete it either.
    const crossDelete = await request(app).delete(`/api/v1/employees/${empId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(crossDelete.status).toBe(200); // route always 200s, but...
    const stillExists = await Employee.findById(empId);
    expect(stillExists).not.toBeNull(); // ...the record must still be there.

    // Company A's list only ever shows its own employees.
    const listA = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body.some((e) => e.id === empId)).toBe(true);
    const listB = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${tokenB}`);
    expect(listB.body.some((e) => e.id === empId)).toBe(false);
  });

  it('supports bulk update and soft delete (termination)', async () => {
    const tokenA = await seedCompany('CompanyA');

    const created = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Bulk Employee', role: 'Engineer', dept: 'Engineering', loc: 'Remote' });
    const empId = created.body.id;

    // Test bulk update
    const bulkRes = await request(app)
      .post('/api/v1/employees/bulk-update')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ids: [empId], patch: { status: 'remote', dept: 'Engineering' } });
    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.updatedCount).toBe(1);

    // Test soft delete
    const softDelRes = await request(app)
      .delete(`/api/v1/employees/${empId}?soft=true`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(softDelRes.status).toBe(200);

    const softDeletedEmp = await Employee.findById(empId);
    expect(softDeletedEmp.status).toBe('terminated');
  });

  it('automatically syncs Employee name and email updates to linked User account', async () => {
    const tokenA = await seedCompany('CompanyA');

    const createdEmp = await Employee.create({
      name: 'Original Employee',
      email: 'orig.emp@companya.com',
      company: 'CompanyA',
    });

    const linkedUser = await User.create({
      name: 'Original Employee',
      email: 'orig.emp@companya.com',
      passwordHash: 'hash',
      role: 'Employee',
      employeeId: createdEmp._id,
      company: 'CompanyA',
    });

    const patchRes = await request(app)
      .patch(`/api/v1/employees/${createdEmp._id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Updated Employee Name', email: 'updated.emp@companya.com' });

    expect(patchRes.status).toBe(200);

    const updatedUser = await User.findById(linkedUser._id);
    expect(updatedUser.name).toBe('Updated Employee Name');
    expect(updatedUser.email).toBe('updated.emp@companya.com');
  });
});
