// Regression test for this session's cross-tenant IDOR fix: every
// single-record employee route must be scoped by company, so a valid
// token from company B can't read/modify/delete company A's records by id.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
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
}, 60000);

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
});
