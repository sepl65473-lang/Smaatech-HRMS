import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';

async function seedUserAndEmployee(role = 'Employee', company = 'CompanyA') {
  await Settings.create({ _id: company, twoFactor: false, gpsCheckInEnabled: false });
  const emp = await Employee.create({ name: 'Test Emp', role, dept: 'Engineering', company });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `emp-${Date.now()}@example.com`;
  const user = await User.create({
    name: 'Test Emp', email, passwordHash, role, company, employeeId: emp._id, active: true,
  });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.accessToken, emp, user };
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

describe('Attendance Check-in and Check-out fixes', () => {
  it('auto-creates today\'s attendance row on GET /attendance if missing for the logged in user', async () => {
    const { token, emp } = await seedUserAndEmployee('HR Manager');
    // Ensure no attendance row exists for today
    await Attendance.deleteMany({ empId: emp._id });

    const res = await request(app).get('/api/v1/attendance').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.find((a) => a.empId === String(emp._id) && a.date === todayISO());
    expect(row).toBeDefined();
    expect(row.status).toBe('absent');
    expect(row.checkIn).toBeNull();
  });

  it('rejects checking out before checking in, and rejects duplicate check-in', async () => {
    const { token, emp } = await seedUserAndEmployee('HR Manager');
    const today = todayISO();
    const row = await Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: today, company: 'CompanyA' });

    // Out before in should fail
    const outRes = await request(app).post(`/api/v1/attendance/${row.id}/check-out`).set('Authorization', `Bearer ${token}`);
    expect(outRes.status).toBe(400);
    expect(outRes.body.error.code).toBe('NOT_CHECKED_IN');

    // First check-in succeeds for HR Manager
    const inRes = await request(app).post(`/api/v1/attendance/${row.id}/check-in`).set('Authorization', `Bearer ${token}`);
    expect(inRes.status).toBe(200);
    expect(inRes.body.checkIn).toBeDefined();

    // Second check-in should fail with ALREADY_CHECKED_IN
    const dupInRes = await request(app).post(`/api/v1/attendance/${row.id}/check-in`).set('Authorization', `Bearer ${token}`);
    expect(dupInRes.status).toBe(400);
    expect(dupInRes.body.error.code).toBe('ALREADY_CHECKED_IN');
  });
});
