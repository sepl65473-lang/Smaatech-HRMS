// Regression tests for a batch of cross-tenant IDOR fixes found by auditing
// every other route for the same missing-companyFilter pattern that was
// previously fixed in employees.js: notifications.js, files.js (attendance
// photos), celebrations.js, and users.js (employeeId linking).
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
const Notification = (await import('../models/Notification.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Wish = (await import('../models/Wish.js')).default;

const PASSWORD = 'CorrectPass123';

async function ensureHrManagerRole() {
  // requireRole() looks this up from the DB (not just the JWT's role name).
  // Needs both manageEmployees (celebrations/employees) and manageUsers
  // (users.js) so one seeded role covers every route under test here.
  const exists = await Role.findOne({ name: 'HR Manager' });
  if (!exists) {
    await Role.create({
      name: 'HR Manager',
      description: 'Manage employee directory and logins',
      allowedPaths: ['/employees', '/users'],
      allowedActions: ['manageEmployees', 'manageUsers'],
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

describe('cross-tenant isolation on /notifications/:id', () => {
  it('a company-B token cannot mark-read or delete a company-A global notification', async () => {
    const tokenA = await seedCompany('CompanyA');
    const tokenB = await seedCompany('CompanyB');
    const note = await Notification.create({
      recipientId: null, title: 'Payroll run complete', message: 'x', company: 'CompanyA',
    });

    const crossRead = await request(app)
      .patch(`/api/v1/notifications/${note.id}/read`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(crossRead.status).toBe(404);

    const crossDelete = await request(app)
      .delete(`/api/v1/notifications/${note.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(crossDelete.status).toBe(404);

    const stillThere = await Notification.findById(note.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere.read).toBe(false);

    const ownRead = await request(app)
      .patch(`/api/v1/notifications/${note.id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(ownRead.status).toBe(200);
  });
});

describe('cross-tenant isolation on /files/attendance/:attendanceId/:which', () => {
  it('a company-B token cannot reach a company-A attendance photo by id', async () => {
    const tokenA = await seedCompany('CompanyA');
    const tokenB = await seedCompany('CompanyB');
    const emp = await Employee.create({
      name: 'Photo Emp', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: 'CompanyA',
    });
    const row = await Attendance.create({ empId: emp._id, date: '2026-07-20', company: 'CompanyA' });

    const crossFetch = await request(app)
      .get(`/api/v1/files/attendance/${row.id}/checkIn`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(crossFetch.status).toBe(404);
    expect(crossFetch.body.error.message).toBe('Attendance row not found.');

    // Own-company request clears the tenant-scope gate (reaches the
    // photo-lookup step instead), proving the block above was company-scope,
    // not a blanket rejection.
    const ownFetch = await request(app)
      .get(`/api/v1/files/attendance/${row.id}/checkIn`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(ownFetch.status).toBe(404);
    expect(ownFetch.body.error.message).toBe('No photo on file for this record.');
  });
});

describe('cross-tenant isolation on /celebrations/:id', () => {
  it('a company-B token cannot record a wish for a company-A employee', async () => {
    const tokenA = await seedCompany('CompanyA');
    const tokenB = await seedCompany('CompanyB');
    const emp = await Employee.create({
      name: 'Bday Emp', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: 'CompanyA',
    });
    const celebrationId = `${emp._id}-birthday-2026`;

    const crossPatch = await request(app)
      .patch(`/api/v1/celebrations/${celebrationId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(crossPatch.status).toBe(404);
    expect(await Wish.countDocuments()).toBe(0);

    const ownPatch = await request(app)
      .patch(`/api/v1/celebrations/${celebrationId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(ownPatch.status).toBe(200);
    expect(await Wish.countDocuments()).toBe(1);
  });
});

describe('cross-tenant isolation on POST/PATCH /users employeeId link', () => {
  it('a company-B token cannot link a new login to a company-A employee', async () => {
    const tokenA = await seedCompany('CompanyA');
    const tokenB = await seedCompany('CompanyB');
    const empA = await Employee.create({
      name: 'Linked Emp', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: 'CompanyA',
    });

    const crossCreate = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        name: 'New Login', email: 'new-login@example.com', password: PASSWORD, role: 'Employee', employeeId: String(empA._id),
      });
    expect(crossCreate.status).toBe(404);
    expect(crossCreate.body.error.code).toBe('EMPLOYEE_NOT_FOUND');

    const ownCreate = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'New Login', email: 'new-login@example.com', password: PASSWORD, role: 'Employee', employeeId: String(empA._id),
      });
    expect(ownCreate.status).toBe(201);
  });
});
