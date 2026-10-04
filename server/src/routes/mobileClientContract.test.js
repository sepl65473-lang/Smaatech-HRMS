// MOBILE APP ↔ BACKEND CONTRACT TESTS.
//
// Replays the exact request shapes sent by the Android app in
// `Mobile Application/src/services/api.ts`, `endpoints.ts` and
// `attendance/punch.ts`, against the real Express app. The app has no browser
// cookie jar: it reads the refresh token out of Set-Cookie and sends it back
// as an explicit Cookie header, so that path is exercised here without a
// cookie-holding agent.
//
// If a contract the mobile app depends on changes, a test here should fail
// before a phone finds it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const ENROLLED = Array(128).fill(0.1);
const STRANGER = Array(128).fill(0.9);

// What the server's face model "sees" in the next uploaded photo.
const face = vi.hoisted(() => ({ result: null }));
vi.mock('../lib/faceEngine.js', async (importOriginal) => ({
  ...(await importOriginal()),
  extractDescriptor: vi.fn(async () => face.result),
}));
const clock = vi.hoisted(() => ({ now: '18:30' }));
vi.mock('../lib/shifts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nowTimeIST: () => clock.now,
}));
vi.mock('../lib/geocode.js', () => ({
  reverseGeocode: vi.fn(async () => ({ display: 'Test Area, Bengaluru', lat: 12.9716, lng: 77.5946, source: 'cache' })),
}));
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
const Role = (await import('../models/Role.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const Payroll = (await import('../models/Payroll.js')).default;
const Notification = (await import('../models/Notification.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'Smaatech';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) SmaatechHRMS/1.0.0';

function photo(seed = 1) {
  const size = 160;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = (i * 7 + seed * 31) % 256;
    data[i * 4 + 1] = (i * 13 + seed * 17) % 256;
    data[i * 4 + 2] = (i * 3 + seed * 53) % 256;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width: size, height: size }, 80).data;
}

// The app's own parser (api.ts extractRefreshCookie), applied to the header as
// React Native presents it: one string.
function refreshTokenFrom(res) {
  const header = [].concat(res.headers['set-cookie'] || []).join(', ');
  const match = /sepl_refresh=([^;,\s]+)/.exec(header);
  return match ? match[1] : null;
}

const api = (method, path, token) => {
  const req = request(app)[method](`/api/v1${path}`).set('User-Agent', UA).set('Accept', 'application/json');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

let seq = 0;
async function seed(role, { enrol = true, phone = '', managerId = null } = {}) {
  seq += 1;
  const emp = await Employee.create({
    name: `${role} ${seq}`, role: 'Engineer', dept: 'Engineering', company: COMPANY,
    email: `user${seq}@example.com`, phone, salary: 50000, managerId,
  });
  const user = await User.create({
    name: emp.name, email: emp.email, passwordHash: await bcrypt.hash(PASSWORD, 10),
    role, company: COMPANY, employeeId: emp._id, active: true,
  });
  if (enrol) await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
  const login = await api('post', '/auth/login').send({ email: emp.email, password: PASSWORD });
  return { emp, user, token: login.body.accessToken, refresh: refreshTokenFrom(login), empId: String(emp._id) };
}

// attendanceApi.forEmployee for "today": this is how the app finds the row id.
async function todayRow(person) {
  const today = todayISO();
  const res = await api('get', `/attendance?empId=${person.empId}&from=${today}&to=${today}&page=1&limit=200`, person.token);
  expect(res.status).toBe(200);
  return res.body.rows.find((row) => row.empId === person.empId);
}

// punch.ts submitPunch: multipart with lat/lng/accuracy/timestamp/deviceId/photo.
function punch(person, rowId, direction, { withPhoto = true, withCoords = true } = {}) {
  const req = api('post', `/attendance/${rowId}/check-${direction}`, person.token);
  if (withCoords) {
    req.field('lat', '12.9716').field('lng', '77.5946').field('accuracy', '12').field('timestamp', String(Date.now()));
  }
  req.field('deviceId', `android-test-${person.empId}`);
  if (withPhoto) req.attach('photo', photo(seq), { filename: `check-${direction}.jpg`, contentType: 'image/jpeg' });
  return req;
}

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });

beforeEach(async () => {
  await clearTestDB();
  face.result = { descriptor: ENROLLED };
  clock.now = '18:30';
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, livenessRequired: false });
  const roles = {
    'HR Director': ['manageEmployees', 'manageUsers', 'manageRoles', 'manageSettings', 'managePayroll', 'manageLeave', 'manageAttendance'],
    'HR Manager': ['manageEmployees', 'manageAttendance', 'manageLeave'],
    'Finance Lead': ['managePayroll', 'manageDocuments'],
    Employee: [],
  };
  for (const [name, allowedActions] of Object.entries(roles)) await Role.create({ name, allowedActions });
});

describe('mobile session handling', () => {
  it('signs in by email and by mobile number, and never returns the password hash', async () => {
    const person = await seed('Employee', { phone: '+91 98765 43210' });
    expect(person.token).toBeTruthy();
    expect(person.refresh).toMatch(/^[0-9a-f]{96}$/);

    const byMobile = await api('post', '/auth/login-mobile').send({ mobile: '9876543210', password: PASSWORD });
    expect(byMobile.status).toBe(200);
    expect(byMobile.body.user.employeeId).toBe(person.empId);
    expect(byMobile.body.user.passwordHash).toBeUndefined();

    const wrong = await api('post', '/auth/login').send({ email: person.emp.email, password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(refreshTokenFrom(wrong)).toBeNull();
  });

  it('refreshes with an explicit Cookie header and rotates the token', async () => {
    const person = await seed('Employee');

    const refreshed = await api('post', '/auth/refresh').set('Cookie', `sepl_refresh=${person.refresh}`).send({});
    expect(refreshed.status).toBe(200);
    const rotated = refreshTokenFrom(refreshed);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(person.refresh);
    expect(refreshed.body.user.role).toBe('Employee');

    // The old token is single-use; the app must have stored the new one.
    const replay = await api('post', '/auth/refresh').set('Cookie', `sepl_refresh=${person.refresh}`).send({});
    expect(replay.status).toBe(401);
    // A cleared cookie must not be mistaken for a token.
    expect(refreshTokenFrom(replay)).toBeNull();

    const none = await api('post', '/auth/refresh').send({});
    expect(none.status).toBe(401);
  });

  it('records the sign-in location after login, or that it was not shared, without affecting the session', async () => {
    const shared = await seed('Employee');
    const sent = await api('post', '/auth/login-location', shared.token)
      .set('Cookie', `sepl_refresh=${shared.refresh}`)
      .send({ lat: 12.9716, lng: 77.5946, accuracy: 12, timestamp: Date.now() });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ recorded: true, location: 'Test Area, Bengaluru' });

    const denied = await seed('Employee');
    const refused = await api('post', '/auth/login-location', denied.token)
      .set('Cookie', `sepl_refresh=${denied.refresh}`)
      .send({ status: 'denied' });
    expect(refused.status).toBe(200);
    expect(refused.body.location).toBe('Location not shared');
    expect((await api('get', '/leaves/balance', denied.token)).status).toBe(200);
  });

  it('sign-out revokes the refresh token on the server', async () => {
    const person = await seed('Employee');
    const out = await api('post', '/auth/logout').set('Cookie', `sepl_refresh=${person.refresh}`).send({});
    expect(out.status).toBe(200);
    const after = await api('post', '/auth/refresh').set('Cookie', `sepl_refresh=${person.refresh}`).send({});
    expect(after.status).toBe(401);
  });

  it('rejects a missing or forged access token on every endpoint the app reads', async () => {
    const paths = ['/employees?page=1&limit=25', '/attendance?page=1&limit=10', '/leaves?page=1&limit=25', '/leaves/balance',
      '/leaves/types', '/payroll?page=1&limit=25', '/notifications', '/documents?page=1&limit=25', '/holidays', '/settings',
      '/attendance-corrections', '/face/access/me', '/analytics/overview', '/attendance/liveness/challenge'];
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop
      expect((await api('get', path)).status, path).toBe(401);
      // eslint-disable-next-line no-await-in-loop
      expect((await api('get', path, 'forged.token.value')).status, path).toBe(401);
    }
  });

  it('an account on a temporary password can only change it', async () => {
    const person = await seed('Employee');
    await User.updateOne({ _id: person.user._id }, { mustChangePassword: true });
    const login = await api('post', '/auth/login').send({ email: person.emp.email, password: PASSWORD });
    expect(login.body.user.mustChangePassword).toBe(true);
    const token = login.body.accessToken;

    const blocked = await api('get', '/leaves/balance', token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await api('post', '/auth/change-password', token)
      .set('Cookie', `sepl_refresh=${refreshTokenFrom(login)}`)
      .send({ currentPassword: PASSWORD, newPassword: 'BrandNew456' });
    expect(changed.status).toBe(200);
    const me = await api('get', '/auth/me', token);
    expect(me.body.user.mustChangePassword).toBe(false);
    expect((await api('get', '/leaves/balance', token)).status).toBe(200);
  });
});

describe('mobile face attendance', () => {
  it('records check-in and check-out only from the server response', async () => {
    const person = await seed('Employee');
    const row = await todayRow(person);
    expect(row).toBeTruthy();
    expect(row.checkIn).toBeNull();

    const inRes = await punch(person, row.id, 'in');
    expect(inRes.status).toBe(200);
    expect(inRes.body.checkIn).toBe('18:30');
    expect(inRes.body.checkInDetails).toContain('Face');
    expect(inRes.body.checkInDeviceId).toBe(`android-test-${person.empId}`);
    // The resolved address of where the punch happened.
    expect(inRes.body.checkInAddress).toBe('Test Area, Bengaluru');
    // The User-Agent the app sends is what names the handset on the record.
    expect(inRes.body.checkInDevice.os).toContain('Android');

    const outRes = await punch(person, row.id, 'out');
    expect(outRes.status).toBe(200);
    expect(outRes.body.checkOut).toBe('18:30');
  });

  it('records the actual place even when a company site is configured at the same point', async () => {
    // A site configured at the punch coordinates changes nothing: no company name, no blocking.
    await Settings.updateOne({ _id: COMPANY }, { orgName: 'Smaatech Engineering Pvt Ltd', geofenceLat: 12.9716, geofenceLng: 77.5946, geofenceRadius: 50 });
    const person = await seed('Employee');
    const row = await todayRow(person);
    const res = await punch(person, row.id, 'in');
    expect(res.status).toBe(200);
    expect(res.body.checkInAddress).toBe('Test Area, Bengaluru');
    expect(res.body.checkInLocation.lat).toBeCloseTo(12.9716, 4);
    expect(res.body.checkInAccuracy).toBe(12);
  });

  it("rejects another person's face on a valid login", async () => {
    const person = await seed('Employee');
    const row = await todayRow(person);
    face.result = { descriptor: STRANGER };
    const res = await punch(person, row.id, 'in');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FACE_NOT_MATCHED');
    expect((await todayRow(person)).checkIn).toBeNull();
  });

  it.each([
    ['NO_FACE'], ['MULTIPLE_FACES'], ['LOW_QUALITY'], ['LOW_RESOLUTION'],
  ])('rejects a capture the server reports as %s, with a readable message', async (code) => {
    const person = await seed('Employee');
    const row = await todayRow(person);
    face.result = { error: code };
    const res = await punch(person, row.id, 'in');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message.length).toBeGreaterThan(10);
    expect((await todayRow(person)).checkIn).toBeNull();
  });

  it('rejects a punch with no photo, no location, or no enrolled face', async () => {
    const person = await seed('Employee');
    const row = await todayRow(person);
    expect((await punch(person, row.id, 'in', { withPhoto: false })).body.error.code).toBe('NO_PHOTO');
    expect((await punch(person, row.id, 'in', { withCoords: false })).body.error.code).toBe('NO_COORDINATES');

    const fresh = await seed('Employee', { enrol: false });
    const freshRow = await todayRow(fresh);
    expect((await punch(fresh, freshRow.id, 'in')).body.error.code).toBe('NOT_ENROLLED');
    const status = await api('get', '/face/access/me', fresh.token);
    expect(status.body).toMatchObject({ enrolled: false, canEnrol: true });
  });

  it('refuses duplicate and out-of-order punches', async () => {
    const person = await seed('Employee');
    const row = await todayRow(person);

    const early = await punch(person, row.id, 'out');
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('NOT_CHECKED_IN');

    expect((await punch(person, row.id, 'in')).status).toBe(200);
    const again = await punch(person, row.id, 'in');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CHECKED_IN');

    clock.now = '15:00';
    const tooEarly = await punch(person, row.id, 'out');
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error.code).toBe('EARLY_CHECKOUT_REASON_REQUIRED');

    clock.now = '18:30';
    expect((await punch(person, row.id, 'out')).status).toBe(200);
    const twice = await punch(person, row.id, 'out');
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_CHECKED_OUT');
  });

  it('an early check-out reason never stands in for the face check', async () => {
    const person = await seed('Employee');
    const row = await todayRow(person);
    clock.now = '09:30';
    expect((await punch(person, row.id, 'in')).status).toBe(200);

    clock.now = '15:00';
    // No reason: refused before any verification.
    const noReason = await punch(person, row.id, 'out');
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('EARLY_CHECKOUT_REASON_REQUIRED');

    // A reason plus someone else's face: still refused, nothing recorded.
    face.result = { descriptor: STRANGER };
    const stranger = await punch(person, row.id, 'out').field('earlyCheckoutReason', 'Medical reason');
    expect(stranger.status).toBe(400);
    expect(stranger.body.error.code).toBe('FACE_NOT_MATCHED');
    expect((await todayRow(person)).checkOut).toBeNull();

    // A reason plus the employee's own face: recorded, with the reason.
    face.result = { descriptor: ENROLLED };
    const ok = await punch(person, row.id, 'out').field('earlyCheckoutReason', 'Other').field('earlyCheckoutNote', 'Doctor appointment');
    expect(ok.status).toBe(200);
    expect(ok.body.checkOut).toBe('15:00');
    expect(ok.body.earlyCheckoutReason).toBe('Other: Doctor appointment');
    expect(ok.body.checkOutAddress).toBe('Test Area, Bengaluru');
  });

  it('enforces the geofence from raw coordinates when it is enabled', async () => {
    await Settings.updateOne({ _id: COMPANY }, { gpsCheckInEnabled: true, geofenceLat: 19.076, geofenceLng: 72.8777, geofenceRadius: 100 });
    const person = await seed('Employee');
    const row = await todayRow(person);
    const res = await punch(person, row.id, 'in'); // Bengaluru, far outside a Mumbai fence
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');
  });

  it("does not let an employee punch, or read, someone else's row", async () => {
    const mine = await seed('Employee');
    const other = await seed('Employee');
    const otherRow = await todayRow(other);

    const res = await punch(mine, otherRow.id, 'in');
    expect(res.status).toBe(403);
    expect((await api('get', `/attendance/${otherRow.id}`, mine.token)).status).toBe(404);

    // ?empId= cannot widen an employee's view.
    const today = todayISO();
    const list = await api('get', `/attendance?empId=${other.empId}&from=${today}&to=${today}&page=1&limit=200`, mine.token);
    expect(list.body.rows.every((r) => r.empId === mine.empId)).toBe(true);
  });

  it('HR punching their own row is face-verified like anyone else', async () => {
    const hr = await seed('HR Manager');
    const row = await todayRow(hr);
    expect(row.empId).toBe(hr.empId);
    face.result = { descriptor: STRANGER };
    expect((await punch(hr, row.id, 'in')).body.error.code).toBe('FACE_NOT_MATCHED');
  });
});

describe('mobile role scoping', () => {
  it('employee: own data only, and no HR, finance or admin endpoints', async () => {
    const employee = await seed('Employee');
    const other = await seed('Employee');
    await Payroll.create([
      { empId: employee.emp._id, name: employee.emp.name, cycle: '2026-09', gross: 50000, deductions: 5000, net: 45000, company: COMPANY },
      { empId: other.emp._id, name: other.emp.name, cycle: '2026-09', gross: 90000, deductions: 9000, net: 81000, company: COMPANY },
    ]);

    const payroll = await api('get', '/payroll?page=1&limit=25', employee.token);
    expect(payroll.body.rows.map((r) => r.empId)).toEqual([employee.empId]);

    const colleague = await api('get', `/employees/${other.empId}`, employee.token);
    expect(colleague.status).toBe(200);
    expect(colleague.body.salary).toBeUndefined();
    expect(colleague.body.phone).toBeUndefined();

    const self = await api('get', `/employees/${employee.empId}`, employee.token);
    expect(self.body.salary).toBe(50000);

    expect((await api('get', '/analytics/overview', employee.token)).status).toBe(403);
    expect((await api('get', `/leaves/balance?empId=${other.empId}`, employee.token)).status).toBe(403);
    expect((await api('get', '/users', employee.token)).status).toBe(403);
    expect((await api('get', '/audit-logs', employee.token)).status).toBe(403);
    expect((await api('patch', '/settings', employee.token).send({ gpsCheckInEnabled: false })).status).toBe(403);
    expect((await api('post', '/payroll/run', employee.token).send({ cycle: '2026-09' })).status).toBe(403);
    expect((await api('get', '/attendance/verification/attempts', employee.token)).status).toBe(403);

    const settings = await api('get', '/settings', employee.token);
    expect(settings.status).toBe(200);
    expect(settings.body.gatewaySmtpPass).toBeUndefined();
    expect(settings.body.livenessRequired).toBe(false);
  });

  it('HR and Admin: company attendance, people, reports', async () => {
    const employee = await seed('Employee');
    for (const role of ['HR Manager', 'HR Director']) {
      // eslint-disable-next-line no-await-in-loop
      const hr = await seed(role);
      // eslint-disable-next-line no-await-in-loop
      await todayRow(employee);

      // eslint-disable-next-line no-await-in-loop
      const roster = await api('get', `/attendance?date=${todayISO()}&page=1&limit=200`, hr.token);
      expect(roster.status).toBe(200);
      expect(roster.body.rows.some((r) => r.empId === employee.empId)).toBe(true);

      // eslint-disable-next-line no-await-in-loop
      const people = await api('get', '/employees?page=1&limit=25&sort=name&search=Employee', hr.token);
      expect(people.body.total).toBeGreaterThanOrEqual(1);
      expect(people.body.rows[0].salary).toBe(50000);

      // eslint-disable-next-line no-await-in-loop
      expect((await api('get', `/leaves/balance?empId=${employee.empId}`, hr.token)).status).toBe(200);

      const today = todayISO();
      // eslint-disable-next-line no-await-in-loop
      const overview = await api('get', `/analytics/overview?from=${today.slice(0, 8)}01&to=${today}`, hr.token);
      expect(overview.status).toBe(200);
      expect(overview.body.headcount.total).toBeGreaterThanOrEqual(2);
      expect(overview.body.payroll).toBeDefined();
    }
  });

  it('Finance: all payroll and reports, but no HR actions', async () => {
    const employee = await seed('Employee');
    const finance = await seed('Finance Lead');
    await Payroll.create({ empId: employee.emp._id, name: employee.emp.name, cycle: '2026-09', gross: 50000, deductions: 5000, net: 45000, company: COMPANY });

    const payroll = await api('get', '/payroll?page=1&limit=25&cycle=2026-09', finance.token);
    expect(payroll.body.total).toBe(1);
    expect((await api('get', '/analytics/overview', finance.token)).status).toBe(200);

    // Finance sees only their own attendance and cannot decide corrections.
    const roster = await api('get', `/attendance?date=${todayISO()}&page=1&limit=200`, finance.token);
    expect(roster.body.rows.every((r) => r.empId === finance.empId)).toBe(true);
    const correction = await api('post', '/attendance-corrections', employee.token).send({
      employeeId: employee.empId, date: todayISO(), requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Forgot to punch',
    });
    expect(correction.status).toBe(201);
    expect((await api('post', `/attendance-corrections/${correction.body.id}/approve`, finance.token).send({})).status).toBe(403);
  });
});

describe('mobile leave, corrections and notifications', () => {
  it('runs a leave request through filing, approval stages and rejection', async () => {
    const employee = await seed('Employee');
    const manager = await seed('HR Manager');
    const director = await seed('HR Director');

    const types = await api('get', '/leaves/types', employee.token);
    expect(types.body.some((t) => t.code === 'sick')).toBe(true);

    const body = { empId: employee.empId, type: 'sick', start: '2026-10-05', end: '2026-10-05', reason: 'Fever', isHalfDay: false };
    const filed = await api('post', '/leaves', employee.token).send(body);
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe('pending');

    const overlap = await api('post', '/leaves', employee.token).send(body);
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OVERLAPPING_LEAVE');

    // Filing for someone else, or deciding your own request, is refused.
    expect((await api('post', '/leaves', employee.token).send({ ...body, empId: manager.empId, start: '2026-10-06', end: '2026-10-06' })).status).toBe(403);
    expect((await api('post', `/leaves/${filed.body.id}/approve`, employee.token).send({ note: '' })).status).toBe(403);

    const balance = await api('get', '/leaves/balance', employee.token);
    expect(balance.body.balances.find((b) => b.type === 'sick').pending).toBe(1);

    const pending = await api('get', '/leaves?page=1&limit=25&status=pending', manager.token);
    expect(pending.body.rows.map((r) => r.id)).toContain(filed.body.id);

    const stage1 = await api('post', `/leaves/${filed.body.id}/approve`, manager.token).send({ note: 'ok' });
    expect(stage1.status).toBe(200);
    const final = stage1.body.status === 'approved'
      ? stage1
      : await api('post', `/leaves/${filed.body.id}/approve`, director.token).send({ note: 'ok' });
    expect(final.body.status).toBe('approved');

    const second = await api('post', '/leaves', employee.token).send({ ...body, start: '2026-10-07', end: '2026-10-07', isHalfDay: true, halfDayTiming: 'first-half' });
    expect(second.status).toBe(201);
    const declined = await api('post', `/leaves/${second.body.id}/decline`, manager.token).send({ note: 'Release week' });
    expect(declined.body.status).toBe('declined');
    expect(declined.body.declineReason).toBe('Release week');

    const cancelled = await api('post', `/leaves/${filed.body.id}/withdraw`, employee.token).send({});
    expect(cancelled.body.status).toBe('cancelled');

    // The decisions reached the employee's inbox, and they can mark them read.
    const inbox = await api('get', '/notifications', employee.token);
    expect(inbox.body.some((n) => n.title === 'Leave Request Approved')).toBe(true);
    const first = inbox.body[0];
    const read = await api('patch', `/notifications/${first.id}/read`, employee.token).send({});
    expect(read.body.read).toBe(true);
    expect((await api('patch', '/notifications/read-all', employee.token).send({})).status).toBe(200);
  });

  it('runs an attendance correction through request, rejection and approval', async () => {
    const employee = await seed('Employee');
    const hr = await seed('HR Manager');
    const date = todayISO();
    const body = { employeeId: employee.empId, date, requestedCheckIn: '09:05', requestedCheckOut: '18:10', reason: 'Camera failed' };

    const created = await api('post', '/attendance-corrections', employee.token).send(body);
    expect(created.status).toBe(201);
    expect((await api('post', '/attendance-corrections', employee.token).send(body)).status).toBe(409);
    expect((await api('post', `/attendance-corrections/${created.body.id}/approve`, employee.token).send({})).status).toBe(403);

    const rejected = await api('post', `/attendance-corrections/${created.body.id}/reject`, hr.token).send({ note: 'No evidence', reviewNote: 'No evidence' });
    expect(rejected.body.status).toBe('Rejected');
    expect(rejected.body.reviewNote).toBe('No evidence');

    const again = await api('post', '/attendance-corrections', employee.token).send(body);
    const approved = await api('post', `/attendance-corrections/${again.body.id}/approve`, hr.token).send({});
    expect(approved.status).toBe(200);
    const row = await todayRow(employee);
    expect(row.checkIn).toBe('09:05');
    expect(row.checkOut).toBe('18:10');

    const mine = await api('get', '/attendance-corrections', employee.token);
    expect(mine.body.every((c) => c.employeeId === employee.empId)).toBe(true);
  });

  it("does not show one user's notifications to another", async () => {
    const a = await seed('Employee');
    const b = await seed('Employee');
    const note = await Notification.create({ recipientId: a.user._id, title: 'Private', message: 'For A only', company: COMPANY });
    expect((await api('get', '/notifications', b.token)).body.some((n) => n.title === 'Private')).toBe(false);
    expect((await api('patch', `/notifications/${note._id}/read`, b.token).send({})).status).toBe(404);
  });
});
