// Server-side reporting.
//
// The point of these tests is the one thing the old client-side reporting got
// wrong: figures must come from the WHOLE collection, not from the first page
// of rows a browser happened to hold. So the fixture deliberately seeds more
// attendance than any unpaged list endpoint would ever return.
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
const Attendance = (await import('../models/Attendance.js')).default;
const Leave = (await import('../models/Leave.js')).default;
const Payroll = (await import('../models/Payroll.js')).default;
const Role = (await import('../models/Role.js')).default;
const Candidate = (await import('../models/Candidate.js')).default;
const LifecycleEvent = (await import('../models/LifecycleEvent.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'ReportCo';

async function ensureRoles() {
  const roles = [
    { name: 'HR Manager', allowedActions: ['manageEmployees'] },
    { name: 'Finance Lead', allowedActions: ['managePayroll'] },
    { name: 'Employee', allowedActions: [] },
  ];
  for (const role of roles) {
    if (!(await Role.findOne({ name: role.name }))) {
      await Role.create({ description: role.name, allowedPaths: ['/'], ...role });
    }
  }
}

async function seedUser(role, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@reportco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

// 3 employees x 60 days = 180 attendance rows, comfortably past the 100-row cap
// an unpaged GET /attendance returns — the exact condition that made the old
// browser-side attendance rate wrong.
const DAYS = 60;
const FROM = '2026-03-01';
const TO = '2026-04-29';

function isoDay(offset) {
  const d = new Date(Date.UTC(2026, 2, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();

  const eng = await Employee.create({ name: 'Eng One', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY, status: 'active', salary: 100000 });
  const eng2 = await Employee.create({ name: 'Eng Two', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY, status: 'active', salary: 90000 });
  const sales = await Employee.create({ name: 'Sales One', role: 'AE', dept: 'Sales', loc: 'Remote', company: COMPANY, status: 'active', salary: 80000 });

  const rows = [];
  for (let day = 0; day < DAYS; day += 1) {
    const date = isoDay(day);
    // Engineering: 2 present, Sales: absent every third day.
    rows.push({ empId: eng._id, name: eng.name, dept: 'Engineering', date, status: 'present', company: COMPANY });
    rows.push({ empId: eng2._id, name: eng2.name, dept: 'Engineering', date, status: day % 10 === 0 ? 'late' : 'present', company: COMPANY });
    rows.push({ empId: sales._id, name: sales.name, dept: 'Sales', date, status: day % 3 === 0 ? 'absent' : 'present', company: COMPANY });
  }
  await Attendance.insertMany(rows);

  await Leave.create({
    empId: eng._id, name: eng.name, dept: 'Engineering', type: 'casual',
    start: '2026-03-10', end: '2026-03-11', workingDays: 2, status: 'approved',
    company: COMPANY, leaveYear: 2026,
  });
  await Leave.create({
    empId: sales._id, name: sales.name, dept: 'Sales', type: 'sick',
    start: '2026-03-20', end: '2026-03-20', workingDays: 1, status: 'pending',
    company: COMPANY, leaveYear: 2026,
  });

  await Payroll.create({ empId: eng._id, name: eng.name, dept: 'Engineering', cycle: '2026-03', gross: 100000, deductions: 20000, net: 80000, status: 'paid', company: COMPANY });
  await Payroll.create({ empId: sales._id, name: sales.name, dept: 'Sales', cycle: '2026-03', gross: 80000, deductions: 16000, net: 64000, status: 'ready', company: COMPANY });

  return {
    hr: await seedUser('HR Manager'),
    finance: await seedUser('Finance Lead'),
    employee: await seedUser('Employee', eng._id),
    eng, eng2, sales,
  };
}

const overview = (token, qs = `from=${FROM}&to=${TO}`) => request(app)
  .get(`/api/v1/analytics/overview?${qs}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('GET /analytics/overview', () => {
  it('aggregates over the WHOLE collection, not the first page of rows', async () => {
    const { hr } = await seed();
    const res = await overview(hr);
    expect(res.status).toBe(200);

    // 180 rows, all of them — the unpaged list endpoint would have shown 100.
    expect(res.body.attendance.marked).toBe(DAYS * 3);
    expect(res.body.attendance.marked).toBeGreaterThan(100);

    const absent = Math.ceil(DAYS / 3); // sales, every third day
    expect(res.body.attendance.absent).toBe(absent);
    expect(res.body.attendance.present).toBe(DAYS * 3 - absent);
    expect(res.body.attendance.ratePct)
      .toBe(Math.round(((DAYS * 3 - absent) / (DAYS * 3)) * 1000) / 10);
  });

  it('reports headcount, leave and payroll for the same window', async () => {
    const { hr } = await seed();
    const res = await overview(hr);

    expect(res.body.headcount.total).toBe(3);
    expect(res.body.headcount.active).toBe(3);

    expect(res.body.leave.approved).toBe(1);
    expect(res.body.leave.approvedDays).toBe(2);
    expect(res.body.leave.pending).toBe(1);

    expect(res.body.payroll.gross).toBe(180000);
    expect(res.body.payroll.net).toBe(144000);
    expect(res.body.payroll.payslips).toBe(2);
    expect(res.body.payroll.paid).toBe(1);
  });

  it('breaks the figures down per department', async () => {
    const { hr } = await seed();
    const res = await overview(hr);

    const engineering = res.body.departments.find((d) => d.dept === 'Engineering');
    const sales = res.body.departments.find((d) => d.dept === 'Sales');

    expect(engineering.headcount).toBe(2);
    expect(engineering.marked).toBe(DAYS * 2);
    expect(engineering.absent).toBe(0);
    expect(engineering.ratePct).toBe(100);

    expect(sales.headcount).toBe(1);
    expect(sales.absent).toBe(Math.ceil(DAYS / 3));
    expect(sales.ratePct).toBeLessThan(100);
  });

  it('honours a department filter', async () => {
    const { hr } = await seed();
    const res = await overview(hr, `from=${FROM}&to=${TO}&dept=Sales`);
    expect(res.body.headcount.total).toBe(1);
    expect(res.body.attendance.marked).toBe(DAYS);
    expect(res.body.payroll.payslips).toBe(1);
  });

  it('honours the date range', async () => {
    const { hr } = await seed();
    const res = await overview(hr, 'from=2026-03-01&to=2026-03-03');
    expect(res.body.attendance.marked).toBe(3 * 3);
    expect(res.body.range).toEqual({ from: '2026-03-01', to: '2026-03-03' });
  });

  it('distinguishes "no data" from "nobody was present"', async () => {
    const { hr } = await seed();
    const res = await overview(hr, 'from=2030-01-01&to=2030-01-31');
    expect(res.body.attendance.marked).toBe(0);
    // null, not 0 — a 0% attendance rate would be a false statement.
    expect(res.body.attendance.ratePct).toBeNull();
  });

  it('never mixes in another company figures', async () => {
    const { hr } = await seed();
    const outsider = await Employee.create({ name: 'Outsider', role: 'Eng', dept: 'Engineering', loc: 'Remote', company: 'OtherCo', status: 'active' });
    await Attendance.insertMany(Array.from({ length: 30 }, (unused, i) => ({
      empId: outsider._id, name: outsider.name, dept: 'Engineering',
      date: isoDay(i), status: 'absent', company: 'OtherCo',
    })));

    const res = await overview(hr);
    expect(res.body.attendance.marked).toBe(DAYS * 3);
    expect(res.body.attendance.absent).toBe(Math.ceil(DAYS / 3));
  });
});

describe('GET /analytics/attendance-trend', () => {
  it('returns one aggregated point per day', async () => {
    const { hr } = await seed();
    const res = await request(app)
      .get(`/api/v1/analytics/attendance-trend?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${hr}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(DAYS);
    for (const day of res.body.days) {
      expect(day.marked).toBe(3);
      expect(day.present + day.absent + day.onLeave).toBe(3);
    }
    // Chronological, so a chart can plot it directly.
    const dates = res.body.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('GET /analytics/workforce — hiring and attrition', () => {
  const workforce = (token, qs = 'from=2026-03-01&to=2026-04-29') => request(app)
    .get(`/api/v1/analytics/workforce?${qs}`).set(`Authorization`, `Bearer ${token}`);

  it('counts joiners in the window and reports who they were', async () => {
    const { hr } = await seed();
    await Employee.create({
      name: 'March Joiner', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
      company: COMPANY, status: 'active', joinDate: '2026-03-15',
    });
    await Employee.create({
      name: 'Later Joiner', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
      company: COMPANY, status: 'active', joinDate: '2026-08-01',
    });

    const res = await workforce(hr);
    expect(res.status).toBe(200);
    expect(res.body.hiring.joined).toBe(1);
    expect(res.body.hiring.joiners[0].name).toBe('March Joiner');
  });

  it('counts exits and expresses attrition against average headcount', async () => {
    const { hr, eng } = await seed();
    await LifecycleEvent.create({
      company: COMPANY, empId: eng._id, employeeName: eng.name,
      type: 'exited', effectiveDate: '2026-03-20', changes: {},
    });
    await Employee.updateOne({ _id: eng._id }, { status: 'exited' });

    const res = await workforce(hr);
    expect(res.body.attrition.exits).toBe(1);
    // The denominator is published alongside the rate, so it can be checked.
    expect(res.body.headcount.average).toBeGreaterThan(0);
    expect(res.body.attrition.ratePct)
      .toBe(Math.round((1 / res.body.headcount.average) * 1000) / 10);
  });

  it('summarises the candidate pipeline and offer outcomes', async () => {
    const { hr } = await seed();
    await Candidate.create({ title: 'Engineer', candidate: 'A', stage: 'Interview', company: COMPANY });
    await Candidate.create({
      title: 'Engineer', candidate: 'B', stage: 'Offer', company: COMPANY,
      offer: { status: 'accepted', salary: 100000, joiningDate: '2026-05-01' },
    });
    await Candidate.create({
      title: 'Engineer', candidate: 'C', stage: 'Offer', company: COMPANY,
      offer: { status: 'declined', salary: 100000, joiningDate: '2026-05-01' },
    });

    const res = await workforce(hr);
    expect(res.body.hiring.pipeline.Interview).toBe(1);
    expect(res.body.hiring.offersAccepted).toBe(1);
    expect(res.body.hiring.offersDeclined).toBe(1);
    expect(res.body.hiring.offerAcceptanceRatePct).toBe(50);
  });

  it('says "no data" rather than 0% when no offer has been answered', async () => {
    const { hr } = await seed();
    const res = await workforce(hr);
    expect(res.body.hiring.offerAcceptanceRatePct).toBeNull();
  });

  it('never counts another company movements', async () => {
    const { hr } = await seed();
    await Employee.create({
      name: 'Other Co Joiner', role: 'Engineer', dept: 'Eng', loc: 'Remote',
      company: 'OtherCo', status: 'active', joinDate: '2026-03-10',
    });
    const res = await workforce(hr);
    expect(res.body.hiring.joiners.some((j) => j.name === 'Other Co Joiner')).toBe(false);
  });

  it('refuses an ordinary employee', async () => {
    const { employee } = await seed();
    expect((await workforce(employee)).status).toBe(403);
  });
});

describe('who can read reporting', () => {
  it('allows HR and Finance', async () => {
    const { hr, finance } = await seed();
    expect((await overview(hr)).status).toBe(200);
    expect((await overview(finance)).status).toBe(200);
  });

  it('refuses an ordinary employee', async () => {
    const { employee } = await seed();
    expect((await overview(employee)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    await seed();
    const res = await request(app).get('/api/v1/analytics/overview');
    expect(res.status).toBe(401);
  });
});
