// A punch is never lost, blocked or held up by the address lookup: the
// coordinates are always stored, and a late address is added afterwards.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.ADDRESS_GRACE_MS = '150';

const ENROLLED = Array(128).fill(0.1);
vi.mock('../lib/faceEngine.js', async (importOriginal) => ({
  ...(await importOriginal()),
  extractDescriptor: vi.fn(async () => ({ descriptor: ENROLLED })),
}));
vi.mock('../lib/shifts.js', async (importOriginal) => ({ ...(await importOriginal()), nowTimeIST: () => '09:30' }));

const LAT = 12.9716; const LNG = 77.5946;
const resolved = {
  placeName: 'Test Area', fullAddress: 'Test Area, Bengaluru, Karnataka, India', pincode: '560001',
  area: 'Test Area', city: 'Bengaluru', district: null, state: 'Karnataka', country: 'India',
  lat: LAT, lng: LNG, accuracy: 10, source: 'nominatim', resolvedAt: new Date().toISOString(),
  display: 'Test Area, Bengaluru, Karnataka, India - 560001',
};
const unresolved = {
  placeName: null, fullAddress: null, pincode: null, area: null, city: null, district: null, state: null, country: null,
  lat: LAT, lng: LNG, accuracy: 10, source: 'unresolved', resolvedAt: new Date().toISOString(), display: null,
};
const geocode = vi.hoisted(() => ({ impl: null }));
vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn((...args) => geocode.impl(...args)) }));
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const COMPANY = 'Smaatech';
function photo() {
  const size = 160; const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) { data[i * 4] = (i * 7) % 256; data[i * 4 + 1] = (i * 13) % 256; data[i * 4 + 2] = (i * 3) % 256; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: size, height: size }, 80).data;
}

let person;
const checkIn = () => request(app).post(`/api/v1/attendance/${person.rowId}/check-in`).set('Authorization', `Bearer ${person.token}`)
  .field('lat', String(LAT)).field('lng', String(LNG)).field('accuracy', '10')
  .attach('photo', photo(), { filename: 'p.jpg', contentType: 'image/jpeg' });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, livenessRequired: false });
  await Role.create({ name: 'Employee', allowedActions: [] });
  const emp = await Employee.create({ name: 'Addr Person', dept: 'Engineering', company: COMPANY, email: 'addr@example.com' });
  const user = await User.create({ name: emp.name, email: emp.email, passwordHash: await bcrypt.hash('CorrectPass123', 10), role: 'Employee', company: COMPANY, employeeId: emp._id, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
  const login = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: 'CorrectPass123' });
  const row = await Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: COMPANY });
  person = { token: login.body.accessToken, rowId: String(row._id) };
});

describe('punch address', () => {
  it('stores coordinates and the address when the lookup answers in time', async () => {
    geocode.impl = async () => resolved;
    const res = await checkIn();
    expect(res.status).toBe(200);
    expect(res.body.checkInLoc).toBe('12.97160, 77.59460');
    expect(res.body.checkInAddress).toBe(resolved.display);
    expect(res.body.checkInLocation).toMatchObject({ lat: LAT, lng: LNG, source: 'nominatim', pincode: '560001' });
  });

  it('records the punch with coordinates only when the lookup fails, and invents no address', async () => {
    geocode.impl = async () => unresolved;
    const res = await checkIn();
    expect(res.status).toBe(200);
    expect(res.body.checkIn).toBe('09:30');
    expect(res.body.checkInLoc).toBe('12.97160, 77.59460');
    expect(res.body.checkInAddress).toBeNull();
    expect(res.body.checkInLocation).toMatchObject({ lat: LAT, lng: LNG, source: 'unresolved' });

    geocode.impl = async () => { throw new Error('provider down'); };
    await Attendance.updateOne({ _id: person.rowId }, { $set: { checkIn: null } });
    expect((await checkIn()).status).toBe(200);
  });

  it('does not wait for a slow lookup, then adds the address to the record when it arrives', async () => {
    geocode.impl = () => after(900, resolved);
    const started = Date.now();
    const res = await checkIn();
    const took = Date.now() - started;
    expect(res.status).toBe(200);
    expect(took).toBeLessThan(800); // answered before the lookup finished
    expect(res.body.checkInLoc).toBe('12.97160, 77.59460');
    expect(res.body.checkInAddress).toBeNull();
    expect(res.body.checkInLocation).toMatchObject({ lat: LAT, lng: LNG, source: 'unresolved' });

    await after(1100);
    const row = await Attendance.findById(person.rowId);
    expect(row.checkIn).toBe('09:30');
    expect(row.checkInLoc).toBe('12.97160, 77.59460');
    expect(row.checkInAddress).toBe(resolved.display);
    expect(row.checkInLocation).toMatchObject({ lat: LAT, lng: LNG, source: 'nominatim', pincode: '560001' });
  });

  it('a slow lookup that ends unresolved leaves the saved punch exactly as it was', async () => {
    geocode.impl = () => after(500, unresolved);
    const res = await checkIn();
    expect(res.status).toBe(200);
    await after(700);
    const row = await Attendance.findById(person.rowId);
    expect(row.checkInAddress).toBeNull();
    expect(row.checkInLoc).toBe('12.97160, 77.59460');
    expect(row.checkInLocation.source).toBe('unresolved');
  });
});
