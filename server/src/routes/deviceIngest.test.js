// A registered face + fingerprint machine as an attendance source:
// POST /api/v1/device-punch, and the HR register behind it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const clock = vi.hoisted(() => ({ time: '09:05' }));
vi.mock('../lib/shifts.js', async (importOriginal) => ({ ...(await importOriginal()), nowTimeIST: () => clock.time }));
const geocode = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/geocode.js', () => ({
  reverseGeocode: vi.fn(async (lat, lng, { accuracy } = {}) => {
    geocode.calls += 1;
    return { placeName: 'Gate Road', fullAddress: 'Gate Road, Test City', pincode: '700001', area: null, city: 'Test City', district: null, state: 'Teststate', country: 'India', lat, lng, accuracy, source: 'nominatim', resolvedAt: new Date().toISOString(), display: 'Gate Road, Test City - 700001' };
  }),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const Device = (await import('../models/Device.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const COMPANY = 'Smaatech';
const PASSWORD = 'CorrectPass123';
const SITE = { siteAddress: 'Main Gate, Unit 4, Industrial Estate, Test City 700001', siteLat: 20.27333, siteLng: 85.87774 };

let seq = 0;
async function person(role = 'Employee') {
  seq += 1;
  const emp = await Employee.create({ name: `${role} ${seq}`, dept: 'Engineering', company: COMPANY, email: `iot${seq}@example.com` });
  await User.create({ name: emp.name, email: emp.email, passwordHash: await bcrypt.hash(PASSWORD, 10), role, company: COMPANY, employeeId: emp._id, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD });
  return { emp, token: login.body.accessToken };
}
const as = (token) => ({
  post: (path, body) => request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  patch: (path, body) => request(app).patch(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body),
  get: (path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
});

let hr; let worker; let device; let key; let n = 0;
const event = (over = {}) => {
  n += 1;
  return { eventId: `evt-${Date.now()}-${n}`, deviceUserId: '1042', type: 'in', verification: 'face_and_fingerprint', timestamp: new Date().toISOString(), ...over };
};
const punch = (body, headers = {}) => request(app).post('/api/v1/device-punch')
  .set({ 'X-Device-Id': device.deviceId, 'X-Device-Key': key, ...headers }).send(body);
const rowOf = (emp) => Attendance.findOne({ empId: emp._id, date: todayISO() });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => {
  await clearTestDB();
  clock.time = '09:05'; geocode.calls = 0;
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, livenessRequired: true });
  for (const name of ['HR Director', 'HR Manager', 'Finance Lead', 'Employee']) await Role.create({ name, allowedActions: [] });
  hr = await person('HR Manager');
  worker = await person();
  const made = await as(hr.token).post('/devices', { deviceId: 'IOT-GATE-01', name: 'Main Gate Terminal', ...SITE });
  expect(made.status).toBe(201);
  device = made.body; key = made.body.deviceKey;
  const mapped = await as(hr.token).post('/device-mappings', { deviceId: device.deviceId, deviceUserId: '1042', empId: String(worker.emp._id) });
  expect(mapped.status).toBe(201);
});

describe('device register (HR only)', () => {
  it('returns the key once, stores only its hash, and never lists it', async () => {
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(device).toMatchObject({ deviceId: 'IOT-GATE-01', name: 'Main Gate Terminal', active: true, hasKey: true, siteAddress: SITE.siteAddress });
    const stored = await Device.findOne({ deviceId: 'IOT-GATE-01' });
    expect(stored.keyHash).not.toBe(key);
    expect(stored.keyHash).toHaveLength(64);
    const list = await as(hr.token).get('/devices');
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(JSON.stringify(list.body)).not.toContain(stored.keyHash);
    expect(await AuditLog.countDocuments({ action: 'Attendance device registered' })).toBe(1);
  });

  it('is refused for employees and without a session, and validates its input', async () => {
    expect((await as(worker.token).post('/devices', { deviceId: 'X-01', name: 'X', ...SITE })).status).toBe(403);
    expect((await as(worker.token).get('/devices')).status).toBe(403);
    expect((await request(app).get('/api/v1/devices')).status).toBe(401);
    expect((await as(hr.token).post('/devices', { deviceId: 'IOT-GATE-01', name: 'Again', ...SITE })).status).toBe(409);
    expect((await as(hr.token).post('/devices', { deviceId: 'IOT-2', name: 'No site' })).status).toBe(400);
    expect((await as(hr.token).post('/devices', { deviceId: 'bad id!', name: 'Bad', ...SITE })).status).toBe(400);
    expect((await as(hr.token).post('/devices', { deviceId: 'IOT-3', name: 'Half coords', siteAddress: 'Somewhere real', siteLat: 20.1 })).status).toBe(400);
  });
});

describe('device authentication', () => {
  it('needs this device\'s own id and key', async () => {
    expect((await request(app).post('/api/v1/device-punch').send(event())).status).toBe(401);
    expect((await punch(event(), { 'X-Device-Key': 'wrong' })).status).toBe(401);
    expect((await punch(event(), { 'X-Device-Id': 'IOT-OTHER' })).status).toBe(401);
    // Another device's key does not open this one.
    const other = await as(hr.token).post('/devices', { deviceId: 'IOT-GATE-02', name: 'Second', ...SITE });
    expect((await punch(event(), { 'X-Device-Key': other.body.deviceKey })).status).toBe(401);
    // The old company-wide key and body field are not a way in.
    await Settings.updateOne({ _id: COMPANY }, { biometricDeviceApiKey: 'company-wide-key' });
    const legacy = await request(app).post('/api/v1/device-punch').set('X-Device-Key', 'company-wide-key').send({ company: COMPANY, deviceId: 'IOT-GATE-01', deviceUserId: '1042', type: 'in' });
    expect(legacy.status).toBe(401);
    expect((await rowOf(worker.emp))?.checkIn ?? null).toBeNull();
  });

  it('a disabled device is refused, a regenerated key replaces the old one', async () => {
    await as(hr.token).patch(`/devices/${device.id}`, { active: false });
    const off = await punch(event());
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('DEVICE_DISABLED');
    await as(hr.token).patch(`/devices/${device.id}`, { active: true });
    const fresh = await as(hr.token).post(`/devices/${device.id}/key`);
    expect((await punch(event())).status).toBe(401); // old key
    key = fresh.body.deviceKey;
    expect((await punch(event())).status).toBe(200);
  });
});

describe('check-in and check-out from the device', () => {
  it('check-in writes the normal attendance row with the registered site as its location', async () => {
    const res = await punch(event());
    expect(res.status).toBe(200);
    const row = await rowOf(worker.emp);
    expect(res.body).toEqual({ success: true, attendanceId: String(row._id), employeeId: String(worker.emp._id), type: 'in', date: todayISO(), time: '09:05', status: 'present', duplicate: false });
    expect(row).toMatchObject({
      checkIn: '09:05', status: 'present', checkOut: null,
      checkInDetails: 'IoT device (Main Gate Terminal) · Face + Fingerprint',
      checkInDeviceId: 'IOT-GATE-01', checkInAddress: SITE.siteAddress, checkInLoc: '20.27333, 85.87774',
    });
    expect(row.checkInLocation).toMatchObject({ source: 'device-site', fullAddress: SITE.siteAddress, lat: SITE.siteLat, lng: SITE.siteLng });
    expect(row.checkInVerification).toMatchObject({ source: 'iot-device', method: 'face_and_fingerprint', deviceId: 'IOT-GATE-01', face: null });
    expect(geocode.calls).toBe(0); // a mounted machine needs no lookup
    const audit = await AuditLog.findOne({ action: 'Attendance check-in' });
    expect(audit.actor).toMatchObject({ role: 'Device' });
    expect(audit.subject).toBe(worker.emp.name);
  });

  it('applies the existing lateness rule, and creates today\'s row when the daily job has not', async () => {
    expect(await rowOf(worker.emp)).toBeNull();
    clock.time = '09:40';
    const res = await punch(event());
    expect(res.body).toMatchObject({ status: 'late', time: '09:40', duplicate: false });
  });

  it('check-out completes the day, stores worked minutes, and an early one is accepted as early exit', async () => {
    await punch(event());
    clock.time = '16:30';
    const out = await punch(event({ type: 'out' }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ type: 'out', time: '16:30', status: 'early-exit', duplicate: false });
    const row = await rowOf(worker.emp);
    expect(row).toMatchObject({ checkIn: '09:05', checkOut: '16:30', workedMinutes: 445, checkOutAddress: SITE.siteAddress, checkOutDeviceId: 'IOT-GATE-01' });
    expect(row.checkOutVerification).toMatchObject({ source: 'iot-device', method: 'face_and_fingerprint' });
    expect(row.earlyCheckoutReason ?? null).toBeNull();

    // After 6 PM the status the day already had is kept.
    await Attendance.updateOne({ _id: row._id }, { checkOut: null, status: 'present', workedMinutes: null });
    clock.time = '18:10';
    expect((await punch(event({ type: 'out' }))).body).toMatchObject({ status: 'present', time: '18:10' });
  });

  it('check-out without a check-in is refused', async () => {
    const res = await punch(event({ type: 'out' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('GPS in the request, when sent, goes through the normal address lookup', async () => {
    const res = await punch(event({ location: { lat: 20.3, lng: 85.8, accuracy: 9 } }));
    expect(res.status).toBe(200);
    const row = await rowOf(worker.emp);
    expect(row).toMatchObject({ checkInLoc: '20.30000, 85.80000', checkInAddress: 'Gate Road, Test City - 700001', checkInAccuracy: 9 });
    expect(row.checkInLocation).toMatchObject({ source: 'nominatim', lat: 20.3, lng: 85.8 });
    const bad = await punch(event({ type: 'out', location: { lat: 200, lng: 85.8 } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_LOCATION');
  });

  it('the punch appears in the HR attendance list like any other', async () => {
    await punch(event());
    const list = await as(hr.token).get(`/attendance?date=${todayISO()}&page=1&limit=50`);
    const row = list.body.rows.find((r) => r.empId === String(worker.emp._id));
    expect(row).toMatchObject({ checkIn: '09:05', status: 'present', checkInAddress: SITE.siteAddress, checkInDetails: 'IoT device (Main Gate Terminal) · Face + Fingerprint' });
  });
});

describe('what the device API refuses', () => {
  it('an unmapped device user, and lets the same event through once HR has mapped them', async () => {
    const body = event({ deviceUserId: '7777' });
    const res = await punch(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEVICE_USER_UNMAPPED');
    const second = await person();
    await as(hr.token).post('/device-mappings', { deviceId: device.deviceId, deviceUserId: '7777', empId: String(second.emp._id) });
    expect((await punch(body)).body).toMatchObject({ success: true, employeeId: String(second.emp._id), duplicate: false });
  });

  it('a punch without both factors, a wrong event type, or missing fields', async () => {
    for (const verification of ['face', 'fingerprint', undefined, 'card']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await punch(event({ verification }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
    }
    expect((await punch(event({ type: 'check_in' }))).body.error.code).toBe('INVALID_EVENT');
    expect((await punch(event({ eventId: 'x' }))).body.error.code).toBe('BAD_REQUEST');
    expect((await punch(event({ deviceUserId: '' }))).body.error.code).toBe('BAD_REQUEST');
    expect((await rowOf(worker.emp))?.checkIn ?? null).toBeNull();
  });

  it('a timestamp that is not current: old, future, or malformed', async () => {
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    for (const timestamp of [at(-6 * 60 * 1000), at(6 * 60 * 1000), at(-24 * 3600 * 1000), '2026-10-08 09:00', '2026-10-08T09:00:00', undefined, 1791000000]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await punch(event({ timestamp }));
      expect(res.status, String(timestamp)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TIMESTAMP');
    }
    expect((await punch(event({ timestamp: at(-4 * 60 * 1000) }))).status).toBe(200); // inside the window
  });
});

describe('duplicates and replays', () => {
  it('the same event sent again returns the first answer and changes nothing', async () => {
    const body = event();
    const first = await punch(body);
    clock.time = '09:30';
    const again = await punch(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, duplicate: true });
    expect((await rowOf(worker.emp)).checkIn).toBe('09:05');
    expect(await AuditLog.countDocuments({ action: 'Attendance check-in' })).toBe(1);
  });

  it('a second check-in with a new event id is acknowledged as a duplicate, not applied', async () => {
    await punch(event());
    clock.time = '11:00';
    const second = await punch(event());
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ success: true, duplicate: true, time: '09:05' });
    expect((await rowOf(worker.emp)).checkIn).toBe('09:05');
  });

  it('two different events arriving together produce one punch', async () => {
    const [a, b] = await Promise.all([punch(event()), punch(event())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
    expect(await AuditLog.countDocuments({ action: 'Attendance check-in' })).toBe(1);
  });
});

describe('mobile and web punches are a separate path', () => {
  it('a device check-in does not satisfy or alter the self-service route, which still needs a photo and location', async () => {
    await punch(event());
    const row = await rowOf(worker.emp);
    const self = await request(app).post(`/api/v1/attendance/${row._id}/check-out`).set('Authorization', `Bearer ${worker.token}`).send({});
    expect([400, 401, 403]).toContain(self.status);
    expect((await rowOf(worker.emp)).checkOut).toBeNull();
  });
});
