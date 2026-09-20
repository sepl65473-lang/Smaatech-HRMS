// The external, redundant trigger for the daily attendance jobs.
//
// The in-process cron stays exactly as it was; this endpoint exists because
// that cron cannot fire while the service is asleep. What matters is that
// running the job twice in a day — once by cron, once from outside — leaves
// the same rows, and that the endpoint is not open to the world.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'test-metrics-token-value';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const COMPANY = 'Smaatech';
const TOKEN = process.env.METRICS_TOKEN;
const trigger = () => request(app)
  .post('/api/v1/internal/jobs/daily-attendance')
  .set('X-Metrics-Token', TOKEN);

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY });
});

describe('POST /internal/jobs/daily-attendance', () => {
  it('creates today\'s rows once, and a second run changes nothing', async () => {
    await Employee.create([
      { name: 'One', email: 'one@example.com', dept: 'Engineering', role: 'Engineer', company: COMPANY, status: 'active' },
      { name: 'Two', email: 'two@example.com', dept: 'Engineering', role: 'Engineer', company: COMPANY, status: 'active' },
    ]);

    const first = await trigger();
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(await Attendance.countDocuments({ date: todayISO() })).toBe(2);

    // What happens when the in-process cron ALSO ran today.
    const second = await trigger();
    expect(second.status).toBe(200);
    expect(await Attendance.countDocuments({ date: todayISO() })).toBe(2);
  });

  it('leaves an existing punch untouched rather than resetting the day', async () => {
    const emp = await Employee.create({ name: 'One', email: 'one@example.com', dept: 'Engineering', role: 'Engineer', company: COMPANY, status: 'active' });
    await Attendance.create({
      empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(),
      checkIn: '09:15', status: 'present', company: COMPANY,
    });

    await trigger();

    const rows = await Attendance.find({ date: todayISO() });
    expect(rows).toHaveLength(1);
    expect(rows[0].checkIn).toBe('09:15');
    expect(rows[0].status).toBe('present');
  });

  it('does not write historical days', async () => {
    await Employee.create({ name: 'One', email: 'one@example.com', dept: 'Engineering', role: 'Engineer', company: COMPANY, status: 'active' });
    await trigger();
    const dates = await Attendance.distinct('date');
    expect(dates).toEqual([todayISO()]);
  });

  it('is not open to anonymous callers or to ordinary employees', async () => {
    expect((await request(app).post('/api/v1/internal/jobs/daily-attendance')).status).toBe(401);

    expect((await request(app)
      .post('/api/v1/internal/jobs/daily-attendance')
      .set('X-Metrics-Token', 'not-the-token')).status).toBe(401);

    const passwordHash = await bcrypt.hash('CorrectPass123', 10);
    await User.create({ name: 'Emp', email: 'emp@example.com', passwordHash, role: 'Employee', company: COMPANY, active: true });
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'emp@example.com', password: 'CorrectPass123' });
    const asEmployee = await request(app)
      .post('/api/v1/internal/jobs/daily-attendance')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(asEmployee.status).toBe(403);
  });
});
