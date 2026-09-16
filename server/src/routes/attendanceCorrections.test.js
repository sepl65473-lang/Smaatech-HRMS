// Attendance-correction coverage.
//
// The headline fix: approving a correction previously hardcoded the resulting
// attendance status to 'present'. A correction for 11:30-14:00 against a
// 09:00-18:00 shift became a full present day, skipping the lateness,
// early-exit and half-day rules every other punch goes through — and payroll
// LOP is computed from those statuses, so it was a paid-time error.
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
const Attendance = (await import('../models/Attendance.js')).default;
const AttendanceCorrection = (await import('../models/AttendanceCorrection.js')).default;
const Role = (await import('../models/Role.js')).default;
const { deriveCorrectedStatus } = await import('./attendanceCorrections.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'CorrCo';
const PAST_DATE = '2026-08-03';

const GENERAL_SHIFT = { id: 'shift_general', name: 'General', start: '09:00', end: '18:00', graceMins: 15 };

async function ensureRoles() {
  for (const name of ['HR Manager', 'HR Director', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, allowedActions: name === 'Employee' ? [] : ['manageAttendance'] });
    }
  }
}

async function seedUser(role, employeeId, key) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key}@example.com`;
  await User.create({ name: key, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function scenario() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();
  const emp = await Employee.create({ name: 'Corrigible Person', dept: 'Engineering', company: COMPANY });
  const hrEmp = await Employee.create({ name: 'HR Person', dept: 'HR', company: COMPANY });
  return {
    emp,
    hrEmp,
    empToken: await seedUser('Employee', emp._id, 'corr-emp'),
    hrToken: await seedUser('HR Manager', hrEmp._id, 'corr-hr'),
  };
}

function fileCorrection(token, body) {
  return request(app).post('/api/v1/attendance-corrections').set('Authorization', `Bearer ${token}`).send(body);
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

describe('deriveCorrectedStatus (the rule that was missing entirely)', () => {
  it('marks a normal full day present', () => {
    expect(deriveCorrectedStatus({ checkIn: '09:05', checkOut: '18:10', shift: GENERAL_SHIFT })).toBe('present');
  });

  it('marks a late arrival late, not present', () => {
    expect(deriveCorrectedStatus({ checkIn: '10:30', checkOut: '19:00', shift: GENERAL_SHIFT })).toBe('late');
  });

  it('respects the grace period', () => {
    expect(deriveCorrectedStatus({ checkIn: '09:15', checkOut: '18:00', shift: GENERAL_SHIFT })).toBe('present');
    expect(deriveCorrectedStatus({ checkIn: '09:16', checkOut: '18:00', shift: GENERAL_SHIFT })).toBe('late');
  });

  it('marks a short day half-day, not present', () => {
    // 11:30-14:00 is 2.5 hours of a 9-hour shift.
    expect(deriveCorrectedStatus({ checkIn: '11:30', checkOut: '14:00', shift: GENERAL_SHIFT })).toBe('half-day');
  });

  it('marks an early exit early-exit', () => {
    expect(deriveCorrectedStatus({ checkIn: '09:00', checkOut: '16:00', shift: GENERAL_SHIFT })).toBe('early-exit');
  });

  it('keeps a holiday a holiday', () => {
    expect(deriveCorrectedStatus({ checkIn: '09:00', checkOut: '18:00', shift: GENERAL_SHIFT, isHolidayDate: true })).toBe('holiday');
  });

  it('handles an overnight shift without wrapping', () => {
    const night = { id: 'n', name: 'Night', start: '22:00', end: '06:00', graceMins: 15 };
    expect(deriveCorrectedStatus({ checkIn: '22:05', checkOut: '06:05', shift: night })).toBe('present');
    expect(deriveCorrectedStatus({ checkIn: '23:30', checkOut: '06:00', shift: night })).toBe('late');
  });
});

describe('filing a correction', () => {
  it('rejects malformed times', async () => {
    const { emp, empToken } = await scenario();
    const res = await fileCorrection(empToken, {
      employeeId: String(emp._id), date: PAST_DATE, requestedCheckIn: '99:99', requestedCheckOut: 'lunch', reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a future date', async () => {
    const { emp, empToken } = await scenario();
    const res = await fileCorrection(empToken, {
      employeeId: String(emp._id), date: '2099-01-01', requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FUTURE_DATE');
  });

  it('accepts a reject with no body, because that is what the client sends', async () => {
    // Same contract point as leave decline — see routes/clientContract.test.js.
    const { emp, empToken, hrToken } = await scenario();
    const filed = await fileCorrection(empToken, {
      employeeId: String(emp._id), date: PAST_DATE, requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Forgot',
    });
    const res = await request(app).post(`/api/v1/attendance-corrections/${filed.body.id}/reject`)
      .set('Authorization', `Bearer ${hrToken}`).send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
  });

  it('records the reviewer note when the UI supplies one', async () => {
    const { emp, empToken, hrToken } = await scenario();
    const filed = await fileCorrection(empToken, {
      employeeId: String(emp._id), date: PAST_DATE, requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Forgot',
    });
    const res = await request(app).post(`/api/v1/attendance-corrections/${filed.body.id}/reject`)
      .set('Authorization', `Bearer ${hrToken}`).send({ note: 'No supporting evidence' });
    expect(res.body.reviewNote).toBe('No supporting evidence');
  });

  it('leaves attendance untouched', async () => {
    const { emp, empToken, hrToken } = await scenario();
    await Attendance.create({ empId: emp._id, name: emp.name, date: PAST_DATE, status: 'absent', company: COMPANY });
    const filed = await fileCorrection(empToken, {
      employeeId: String(emp._id), date: PAST_DATE, requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Forgot',
    });
    await request(app).post(`/api/v1/attendance-corrections/${filed.body.id}/reject`)
      .set('Authorization', `Bearer ${hrToken}`).send({ note: 'No supporting evidence' });

    const row = await Attendance.findOne({ empId: emp._id, date: PAST_DATE });
    expect(row.status).toBe('absent');
    expect(row.checkIn).toBeNull();
  });
});
