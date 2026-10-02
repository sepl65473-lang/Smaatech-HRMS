// Location on self check-in / check-out.
//
// A self-punch must carry the employee's current position — geofencing on or
// off — and that position must be a real one. These pin: the coordinates are
// stored per direction, a punch without them is refused and writes nothing,
// and the QR channel stores the same structured location as the face channel.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractDescriptor: vi.fn(async () => ({ descriptor: Array(128).fill(0.1) })),
    extractFaceData: vi.fn(async () => ({ descriptor: Array(128).fill(0.1), geometry: {}, stats: {} })),
  };
});

// Same OBJECT shape the real reverseGeocode returns.
const geocoded = (lat, lng, opts = {}) => ({
  placeName: 'Smaatech Engineering',
  fullAddress: 'Smaatech Engineering, 12 MG Road, Bengaluru, Karnataka, India',
  pincode: '560038',
  area: 'Indiranagar',
  city: 'Bengaluru',
  district: 'Bengaluru Urban',
  state: 'Karnataka',
  country: 'India',
  lat: Number(lat),
  lng: Number(lng),
  accuracy: opts.accuracy ?? null,
  source: 'nominatim',
  resolvedAt: new Date().toISOString(),
  display: 'Smaatech Engineering, 12 MG Road, Bengaluru, Karnataka, India - 560038',
});

vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn() }));

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => ({ sent: true })),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const { reverseGeocode } = await import('../lib/geocode.js');
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const Role = (await import('../models/Role.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'LocationCo';

const IN_AT = { lat: 12.9716, lng: 77.5946, accuracy: 12 };
const OUT_AT = { lat: 13.0827, lng: 80.2707, accuracy: 25 };

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
  const email = `loc${seq}@example.com`;
  const user = await User.create({ name: emp.name, email, passwordHash, role, company: COMPANY, employeeId: emp._id, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: Array(128).fill(0.1) });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.accessToken, emp, user };
}

function rowFor(emp) {
  return Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: COMPANY });
}

// `fields` are sent exactly as given, so a test can omit or corrupt any of them.
function punch(direction, rowId, token, fields) {
  const req = request(app)
    .post(`/api/v1/attendance/${rowId}/check-${direction}`)
    .set('Authorization', `Bearer ${token}`)
    .field('deviceId', 'browser-test-device');
  for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
  return req.attach('photo', makeJpeg(seq), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
}

async function qrToken(hrToken) {
  const res = await request(app).get('/api/v1/attendance/qr-token').set('Authorization', `Bearer ${hrToken}`);
  return res.body.token;
}

function qrPunch(token, body) {
  return request(app).post('/api/v1/attendance/qr-checkin').set('Authorization', `Bearer ${token}`).send(body);
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  reverseGeocode.mockReset();
  reverseGeocode.mockImplementation(async (lat, lng, opts) => geocoded(lat, lng, opts));
  // Geofencing OFF: the case that used to accept a punch with no location.
  await Settings.create({ _id: COMPANY, twoFactor: false, gpsCheckInEnabled: false });
  for (const name of ['HR Manager', 'Employee']) {
    await Role.create({ name, allowedPaths: ['/attendance'], allowedActions: name === 'Employee' ? [] : ['manageAttendance'] });
  }
});

describe('face check-in / check-out stores the location of each punch', () => {
  it('saves check-in coordinates, accuracy and a STRING address', async () => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await punch('in', row.id, token, { ...IN_AT, timestamp: Date.now() });
    expect(res.status).toBe(200);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkInLocation.lat).toBe(IN_AT.lat);
    expect(stored.checkInLocation.lng).toBe(IN_AT.lng);
    expect(stored.checkInLocation.accuracy).toBe(IN_AT.accuracy);
    expect(stored.checkInAccuracy).toBe(IN_AT.accuracy);
    expect(stored.checkInLoc).toBe('12.97160, 77.59460');
    expect(typeof stored.checkInAddress).toBe('string');
    expect(stored.checkInDetails).toBe('Face Verified + GPS Recorded');
    // Geofencing is off, so no geofence verdict is claimed.
    expect(stored.checkInVerification.gps).toEqual({ evaluated: false, reason: 'geofence-disabled' });
    expect(stored.checkOutLocation.lat).toBeNull();
  });

  it('saves check-out coordinates separately and leaves the check-in ones alone', async () => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);
    await punch('in', row.id, token, IN_AT);

    const out = await punch('out', row.id, token, OUT_AT);
    expect(out.status).toBe(200);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkOutLocation.lat).toBe(OUT_AT.lat);
    expect(stored.checkOutLocation.lng).toBe(OUT_AT.lng);
    expect(stored.checkOutAccuracy).toBe(OUT_AT.accuracy);
    expect(stored.checkOutLoc).toBe('13.08270, 80.27070');
    expect(stored.checkInLocation.lat).toBe(IN_AT.lat);
    expect(stored.checkInLocation.lng).toBe(IN_AT.lng);
    expect(stored.checkInLoc).toBe('12.97160, 77.59460');
    expect(stored.checkInAccuracy).toBe(IN_AT.accuracy);
  });

  it('still saves the coordinates when the address lookup fails', async () => {
    reverseGeocode.mockImplementation(async () => { throw new Error('nominatim down'); });
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await punch('in', row.id, token, IN_AT);
    expect(res.status).toBe(200);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkInLocation.lat).toBe(IN_AT.lat);
    expect(stored.checkInLocation.lng).toBe(IN_AT.lng);
    expect(stored.checkInLocation.source).toBe('unresolved');
    expect(stored.checkInAddress).toBeNull();
  });
});

describe('a self-punch without a valid location is refused', () => {
  const cases = [
    ['no coordinates at all', {}, 'NO_COORDINATES'],
    ['missing latitude', { lng: 77.5946 }, 'NO_COORDINATES'],
    ['missing longitude', { lat: 12.9716 }, 'NO_COORDINATES'],
    ['NaN', { lat: 'NaN', lng: 'NaN' }, 'INVALID_COORDINATES'],
    ['Infinity', { lat: 'Infinity', lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['-Infinity longitude', { lat: 12.9716, lng: '-Infinity' }, 'INVALID_COORDINATES'],
    ['non-numeric text', { lat: 'abc', lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['an empty string', { lat: '', lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['latitude > 90', { lat: 90.0001, lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['latitude < -90', { lat: -90.0001, lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['longitude > 180', { lat: 12.9716, lng: 180.0001 }, 'INVALID_COORDINATES'],
    ['longitude < -180', { lat: 12.9716, lng: -180.0001 }, 'INVALID_COORDINATES'],
  ];

  it.each(cases)('check-in with %s', async (_label, fields, code) => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await punch('in', row.id, token, fields);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkIn).toBeNull();
    expect(stored.checkInLoc).toBeNull();
    expect(stored.checkInLocation.lat).toBeNull();
  });

  it.each(cases)('check-out with %s', async (_label, fields, code) => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);
    await punch('in', row.id, token, IN_AT);

    const res = await punch('out', row.id, token, fields);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkOut).toBeNull();
    expect(stored.checkOutLoc).toBeNull();
    expect(stored.checkInLocation.lat).toBe(IN_AT.lat);
  });

  it('accepts the extremes of the valid range', async () => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);
    const res = await punch('in', row.id, token, { lat: -90, lng: 180 });
    expect(res.status).toBe(200);
    expect(res.body.checkInLocation.lat).toBe(-90);
    expect(res.body.checkInLocation.lng).toBe(180);
  });

  it('ignores an unusable accuracy rather than storing it', async () => {
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);
    const res = await punch('in', row.id, token, { lat: 12.9716, lng: 77.5946, accuracy: 'NaN' });
    expect(res.status).toBe(200);
    expect(res.body.checkInAccuracy).toBeNull();
  });
});

describe('HR override on another employee row', () => {
  it('still works without a location', async () => {
    const hr = await seedPerson('HR Manager');
    const { emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${hr.token}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.checkInDetails).toBe('HR Manual Punch');
    expect(res.body.checkInLoc).toBeNull();
  });

  it('refuses invalid coordinates instead of storing them', async () => {
    const hr = await seedPerson('HR Manager');
    const { emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${hr.token}`)
      .send({ lat: 'abc', lng: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_COORDINATES');
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });
});

describe('QR punch', () => {
  it('stores a structured location and a STRING address for check-in, then check-out', async () => {
    const hr = await seedPerson('HR Manager');
    const { token, emp } = await seedPerson();
    await rowFor(emp);

    const inRes = await qrPunch(token, { token: await qrToken(hr.token), ...IN_AT, timestamp: Date.now() });
    // The reverse-geocode object used to be written to the String address
    // field, which Mongoose refuses with a CastError.
    expect(inRes.status).toBe(200);
    expect(inRes.body.checkIn).toBeTruthy();
    expect(inRes.body.checkInLocation.lat).toBe(IN_AT.lat);
    expect(inRes.body.checkInLocation.lng).toBe(IN_AT.lng);
    expect(inRes.body.checkInLocation.accuracy).toBe(IN_AT.accuracy);
    expect(inRes.body.checkInLocation.city).toBe('Bengaluru');
    expect(inRes.body.checkInAccuracy).toBe(IN_AT.accuracy);
    expect(inRes.body.checkInLoc).toBe('12.97160, 77.59460');
    expect(typeof inRes.body.checkInAddress).toBe('string');
    expect(inRes.body.checkInDetails).toBe('QR Check-in + GPS Recorded');

    const outRes = await qrPunch(token, { token: await qrToken(hr.token), ...OUT_AT });
    expect(outRes.status).toBe(200);
    expect(outRes.body.checkOut).toBeTruthy();
    expect(outRes.body.checkOutLocation.lat).toBe(OUT_AT.lat);
    expect(outRes.body.checkOutLocation.lng).toBe(OUT_AT.lng);
    expect(typeof outRes.body.checkOutAddress).toBe('string');
    expect(outRes.body.checkInLocation.lat).toBe(IN_AT.lat);
    expect(outRes.body.checkInLocation.lng).toBe(IN_AT.lng);
  });

  it('still records the coordinates when the address lookup fails', async () => {
    reverseGeocode.mockImplementation(async () => { throw new Error('nominatim down'); });
    const hr = await seedPerson('HR Manager');
    const { token, emp } = await seedPerson();
    await rowFor(emp);

    const res = await qrPunch(token, { token: await qrToken(hr.token), ...IN_AT });
    expect(res.status).toBe(200);
    expect(res.body.checkInLocation.lat).toBe(IN_AT.lat);
    expect(res.body.checkInAddress).toBeNull();
  });

  it.each([
    ['no coordinates', {}, 'NO_COORDINATES'],
    ['a null latitude', { lat: null, lng: 77.5946 }, 'NO_COORDINATES'],
    ['non-numeric text', { lat: 'abc', lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['a boolean', { lat: true, lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['latitude out of range', { lat: 91, lng: 77.5946 }, 'INVALID_COORDINATES'],
    ['longitude out of range', { lat: 12.9716, lng: -181 }, 'INVALID_COORDINATES'],
  ])('is refused with %s', async (_label, coords, code) => {
    const hr = await seedPerson('HR Manager');
    const { token, emp } = await seedPerson();
    const row = await rowFor(emp);

    const res = await qrPunch(token, { token: await qrToken(hr.token), ...coords });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });
});
