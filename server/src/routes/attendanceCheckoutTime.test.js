// The 6:00 PM minimum check-out for the General (09:00-18:00) shift.
//
// A fixed time of day, not check-in + N hours: an employee on the General
// shift cannot check themselves out (face or QR) before 18:00 IST. Other
// shifts, HR overrides on someone else's row, and check-in are unaffected.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// The server's IST time of day, set per test.
const clock = vi.hoisted(() => ({ now: '09:30' }));
vi.mock('../lib/shifts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nowTimeIST: () => clock.now,
}));

vi.mock('../lib/faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractDescriptor: vi.fn(async () => ({ descriptor: Array(128).fill(0.1) })),
    extractFaceData: vi.fn(async () => ({ descriptor: Array(128).fill(0.1), geometry: {}, stats: {} })),
  };
});

vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn(async () => null) }));

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => ({ sent: true })),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const Role = (await import('../models/Role.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'CheckoutCo';
const HERE = { lat: '20.2961', lng: '85.8245', accuracy: '10' };
const TOO_EARLY = 'Check-Out is available from 6:00 PM onwards.';

function makeJpeg(seed = 1) {
  const width = 160; const height = 160;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 7 + seed * 31) % 256;
    data[i * 4 + 1] = (i * 13 + seed * 17) % 256;
    data[i * 4 + 2] = (i * 3 + seed * 53) % 256;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 80).data;
}

let seq = 0;
async function seedPerson(role = 'Employee') {
  seq += 1;
  const emp = await Employee.create({ name: `Person ${seq}`, role, dept: 'Engineering', company: COMPANY });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `checkout${seq}@example.com`;
  const user = await User.create({ name: emp.name, email, passwordHash, role, company: COMPANY, employeeId: emp._id, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: Array(128).fill(0.1) });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.accessToken, emp };
}

function rowFor(emp) {
  return Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: COMPANY });
}

function punch(direction, rowId, token) {
  const req = request(app)
    .post(`/api/v1/attendance/${rowId}/check-${direction}`)
    .set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(HERE)) req.field(k, v);
  return req.attach('photo', makeJpeg(seq), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
}

async function checkedInAt(time, role = 'Employee') {
  const person = await seedPerson(role);
  const row = await rowFor(person.emp);
  clock.now = time;
  const res = await punch('in', row.id, person.token);
  expect(res.status).toBe(200);
  expect(res.body.checkIn).toBe(time);
  return { ...person, row };
}

async function qrToken() {
  const hr = await seedPerson('HR Manager');
  return async () => (await request(app).get('/api/v1/attendance/qr-token').set('Authorization', `Bearer ${hr.token}`)).body.token;
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  clock.now = '09:30';
  await Settings.create({ _id: COMPANY, twoFactor: false, gpsCheckInEnabled: false });
  for (const name of ['HR Manager', 'Employee']) {
    await Role.create({ name, allowedPaths: ['/attendance'], allowedActions: name === 'Employee' ? [] : ['manageAttendance'] });
  }
});

describe('General shift: face check-out before 6:00 PM is refused', () => {
  it.each([
    ['09:30', '17:59', 400],
    ['09:30', '18:00', 200],
    ['10:00', '17:59', 400],
    ['10:00', '18:00', 200],
    ['09:30', '18:45', 200],
    ['09:30', '12:00', 400],
  ])('in at %s, out at %s -> %s', async (inAt, outAt, expected) => {
    const { token, row } = await checkedInAt(inAt);
    const before = (await Attendance.findById(row.id)).toObject();

    clock.now = outAt;
    const res = await punch('out', row.id, token);
    expect(res.status).toBe(expected);

    const after = (await Attendance.findById(row.id)).toObject();
    if (expected === 400) {
      expect(res.body.error).toEqual({ code: 'CHECKOUT_TOO_EARLY', message: TOO_EARLY });
      // Nothing about the record changed.
      expect(after.checkOut).toBeNull();
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.failedVerificationCount).toBe(0);
      expect(after.status).toBe(before.status);
    } else {
      expect(after.checkOut).toBe(outAt);
      expect(after.checkIn).toBe(inAt);
    }
  });

  it('a refused check-out can be completed once it is 6:00 PM', async () => {
    const { token, row } = await checkedInAt('09:30');
    clock.now = '17:30';
    expect((await punch('out', row.id, token)).status).toBe(400);
    clock.now = '18:00';
    const ok = await punch('out', row.id, token);
    expect(ok.status).toBe(200);
    expect(ok.body.checkOut).toBe('18:00');
  });

  it('a direct API call without photo or location is refused the same way', async () => {
    const { token, row } = await checkedInAt('09:30');
    clock.now = '17:59';
    const res = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKOUT_TOO_EARLY');
    expect((await Attendance.findById(row.id)).checkOut).toBeNull();
  });

  it('check-in itself is not restricted', async () => {
    const { row } = await checkedInAt('07:45');
    expect((await Attendance.findById(row.id)).checkIn).toBe('07:45');
  });
});

describe('General shift: QR check-out before 6:00 PM is refused', () => {
  it('blocks at 17:59 and allows at 18:00, leaving the record untouched in between', async () => {
    const nextToken = await qrToken();
    const { token, emp } = await seedPerson();
    await rowFor(emp);

    clock.now = '09:30';
    const inRes = await request(app).post('/api/v1/attendance/qr-checkin').set('Authorization', `Bearer ${token}`)
      .send({ token: await nextToken(), lat: 20.2961, lng: 85.8245 });
    expect(inRes.status).toBe(200);

    clock.now = '17:59';
    const early = await request(app).post('/api/v1/attendance/qr-checkin').set('Authorization', `Bearer ${token}`)
      .send({ token: await nextToken(), lat: 20.2961, lng: 85.8245 });
    expect(early.status).toBe(400);
    expect(early.body.error).toEqual({ code: 'CHECKOUT_TOO_EARLY', message: TOO_EARLY });
    expect((await Attendance.findById(inRes.body.id)).checkOut).toBeNull();

    clock.now = '18:00';
    const ok = await request(app).post('/api/v1/attendance/qr-checkin').set('Authorization', `Bearer ${token}`)
      .send({ token: await nextToken(), lat: 20.2961, lng: 85.8245 });
    expect(ok.status).toBe(200);
    expect(ok.body.checkOut).toBe('18:00');
  });
});

describe('outside the rule', () => {
  it('another shift (Morning 06:00-14:00) checks out at 14:00 as before', async () => {
    const { token, emp } = await seedPerson();
    await Settings.updateOne({ _id: COMPANY }, { employeeShifts: { [String(emp._id)]: 'shift_morning' } });
    const row = await rowFor(emp);
    clock.now = '06:05';
    expect((await punch('in', row.id, token)).status).toBe(200);
    clock.now = '14:00';
    const out = await punch('out', row.id, token);
    expect(out.status).toBe(200);
    expect(out.body.checkOut).toBe('14:00');
  });

  it('an HR override on another employee row is unchanged', async () => {
    const hr = await seedPerson('HR Manager');
    const { emp } = await seedPerson();
    const row = await rowFor(emp);
    clock.now = '09:30';
    expect((await request(app).post(`/api/v1/attendance/${row.id}/check-in`).set('Authorization', `Bearer ${hr.token}`).send()).status).toBe(200);
    clock.now = '15:00';
    const out = await request(app).post(`/api/v1/attendance/${row.id}/check-out`).set('Authorization', `Bearer ${hr.token}`).send();
    expect(out.status).toBe(200);
    expect(out.body.checkOut).toBe('15:00');
  });
});
