// Attendance check-in / check-out photos live for 24 hours, then are deleted
// from storage. Nothing else is: not older photos, not enrolment or
// rejected-attempt photos, not the attendance record.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';
import mongoose from 'mongoose';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.STORAGE_DRIVER = 'gridfs';
process.env.METRICS_TOKEN = 'photo-cleanup-test-token-0123456789';

const ENROLLED = Array(128).fill(0.1);
const face = vi.hoisted(() => ({ result: null }));
vi.mock('../lib/faceEngine.js', async (importOriginal) => ({
  ...(await importOriginal()),
  extractDescriptor: vi.fn(async () => face.result),
}));
vi.mock('../lib/shifts.js', async (importOriginal) => ({ ...(await importOriginal()), nowTimeIST: () => '09:30' }));
vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn(async () => ({ display: 'Test Area, Test City' })) }));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const { savePhoto, readPhoto } = await import('../lib/photoStorage.js');
const { purgeExpiredAttendancePhotos, attendancePhotoExpiry, expiryMetadataFor, ATTENDANCE_PHOTO_TTL_MS } = await import('../lib/attendancePhotoExpiry.js');
const { todayISO } = await import('../lib/dateUtils.js');

const COMPANY = 'Smaatech';
const PASSWORD = 'CorrectPass123';
const HOUR = 60 * 60 * 1000;

function photo(seed = 7) {
  const size = 160; const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) { data[i * 4] = (i * seed) % 256; data[i * 4 + 1] = (i * 13) % 256; data[i * 4 + 2] = (i * 3) % 256; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: size, height: size }, 80).data;
}
const filesCol = () => mongoose.connection.db.collection('hrmsfiles.files');
const chunksCol = () => mongoose.connection.db.collection('hrmsfiles.chunks');
const nameOf = (ref) => ref.replace('gridfs://hrmsfiles/', '');
const fileOf = (ref) => filesCol().findOne({ filename: nameOf(ref) });
const chunkCount = async (ref, id) => chunksCol().countDocuments({ files_id: id ?? (await fileOf(ref))?._id });
/** Moves a stored file's expiry, as if that much time had passed since it was taken. */
const setExpiry = (ref, expiresAt) => filesCol().updateOne({ filename: nameOf(ref) }, { $set: { 'metadata.expiresAt': expiresAt } });

let seq = 0;
async function person(role = 'Employee') {
  seq += 1;
  const emp = await Employee.create({ name: `${role} ${seq}`, dept: 'Engineering', company: COMPANY, email: `photo${seq}@example.com` });
  const user = await User.create({ name: emp.name, email: emp.email, passwordHash: await bcrypt.hash(PASSWORD, 10), role, company: COMPANY, employeeId: emp._id, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
  const login = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD });
  const row = await Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: COMPANY });
  return { emp, token: login.body.accessToken, rowId: String(row._id) };
}
const punch = (p, dir) => request(app).post(`/api/v1/attendance/${p.rowId}/check-${dir}`).set('Authorization', `Bearer ${p.token}`)
  .field('lat', '12.9716').field('lng', '77.5946').field('accuracy', '10')
  // 09:30 is before the General shift ends, so a check-out carries its reason.
  .field('earlyCheckoutReason', dir === 'out' ? 'Medical reason' : '')
  .attach('photo', photo(dir === 'in' ? 7 : 11), { filename: 'p.jpg', contentType: 'image/jpeg' });
const view = (token, rowId, which) => request(app).get(`/api/v1/files/attendance/${rowId}/${which}`).set('Authorization', `Bearer ${token}`);

let worker; let hr;
beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => {
  await clearTestDB();
  await filesCol().deleteMany({}); await chunksCol().deleteMany({});
  face.result = { descriptor: ENROLLED };
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, livenessRequired: false });
  for (const name of ['HR Director', 'HR Manager', 'Finance Lead', 'Employee']) await Role.create({ name, allowedActions: [] });
  worker = await person();
  hr = await person('HR Manager');
});

describe('which files are given a 24-hour life', () => {
  it('only the successful-punch folder is stamped', () => {
    const now = Date.UTC(2026, 9, 9, 6, 0, 0);
    expect(expiryMetadataFor('attendance/665f00000000000000000001', now)).toEqual({ expiresAt: new Date(now + ATTENDANCE_PHOTO_TTL_MS) });
    for (const other of ['attendance-failed/665f00000000000000000001', 'attendance-failed', 'enrollment', 'documents', 'attendances/x', 'my-attendance/x', '', undefined]) {
      expect(expiryMetadataFor(other, now)).toEqual({});
    }
  });

  it('a real check-in and check-out photo each expire 24 hours after they were stored', async () => {
    const before = Date.now();
    expect((await punch(worker, 'in')).status).toBe(200);
    const row = await Attendance.findById(worker.rowId);
    expect(row.checkInPhotoRef).toMatch(/^gridfs:\/\/hrmsfiles\/attendance\//);
    const file = await fileOf(row.checkInPhotoRef);
    const life = file.metadata.expiresAt.getTime() - before;
    expect(life).toBeGreaterThanOrEqual(ATTENDANCE_PHOTO_TTL_MS - 5000);
    expect(life).toBeLessThanOrEqual(ATTENDANCE_PHOTO_TTL_MS + 5000);
    expect((await attendancePhotoExpiry(row.checkInPhotoRef)).getTime()).toBe(file.metadata.expiresAt.getTime());
  });
});

describe('before 24 hours', () => {
  it('HR and the employee can see the photo, and the cleanup leaves it alone', async () => {
    await punch(worker, 'in');
    const row = await Attendance.findById(worker.rowId);
    await setExpiry(row.checkInPhotoRef, new Date(Date.now() + 5 * 60 * 1000)); // 23 h 55 min old
    for (const token of [hr.token, worker.token]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await view(token, worker.rowId, 'checkIn');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.body.length).toBeGreaterThan(500);
      // The browser may not keep it past its expiry either.
      expect(Number(/max-age=(\d+)/.exec(res.headers['cache-control'])[1])).toBeLessThanOrEqual(300);
    }
    expect(await purgeExpiredAttendancePhotos()).toMatchObject({ deleted: 0 });
    expect(await readPhoto(row.checkInPhotoRef)).toBeTruthy();
  });
});

describe('after 24 hours', () => {
  it('the photo is refused at once, then deleted from storage; the attendance record does not change', async () => {
    expect((await punch(worker, 'in')).status).toBe(200);
    expect((await punch(worker, 'out')).status).toBe(200);
    const before = (await Attendance.findById(worker.rowId)).toObject();
    expect(before.checkInPhotoRef).toBeTruthy();
    expect(before.checkOutPhotoRef).toBeTruthy();
    const inFile = await fileOf(before.checkInPhotoRef);
    expect(await chunkCount(null, inFile._id)).toBeGreaterThan(0);

    // 24 hours pass for the check-in photo only.
    await setExpiry(before.checkInPhotoRef, new Date(Date.now() - 1000));

    // Refused straight away, before any cleanup has run - the bytes still exist.
    const refused = await view(hr.token, worker.rowId, 'checkIn');
    expect(refused.status).toBe(410);
    expect(refused.body.error.code).toBe('PHOTO_EXPIRED');
    expect(await fileOf(before.checkInPhotoRef)).toBeTruthy();
    expect((await view(worker.token, worker.rowId, 'checkIn')).status).toBe(410);
    // The check-out photo, still inside its 24 hours, is unaffected.
    expect((await view(hr.token, worker.rowId, 'checkOut')).status).toBe(200);

    const result = await purgeExpiredAttendancePhotos();
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
    expect(await fileOf(before.checkInPhotoRef)).toBeNull(); // file document gone
    expect(await chunkCount(null, inFile._id)).toBe(0); // and every chunk
    expect(await readPhoto(before.checkInPhotoRef)).toBeNull();
    expect((await view(hr.token, worker.rowId, 'checkIn')).status).toBe(404);
    expect(await fileOf(before.checkOutPhotoRef)).toBeTruthy();

    // The record is exactly as it was: reference, times, status, location.
    const after = (await Attendance.findById(worker.rowId)).toObject();
    expect(after).toEqual(before);
    const listed = await request(app).get(`/api/v1/attendance?date=${todayISO()}&page=1&limit=50`).set('Authorization', `Bearer ${hr.token}`);
    expect(listed.body.rows.find((r) => r.id === worker.rowId)).toMatchObject({ checkIn: '09:30', checkOut: '09:30', checkInAddress: 'Test Area, Test City' });

    // A second run has nothing left to do.
    expect(await purgeExpiredAttendancePhotos()).toMatchObject({ deleted: 0 });
  });
});

describe('what is never deleted', () => {
  it('older attendance photos, rejected-attempt photos, enrolment photos and documents', async () => {
    const long = new Date(Date.now() - 40 * 24 * HOUR);
    // An attendance photo stored BEFORE this policy: no expiry on it, however old.
    const legacy = await savePhoto('attendance/665f00000000000000000001', 'legacy.jpg', photo(3));
    await filesCol().updateOne({ filename: nameOf(legacy) }, { $unset: { 'metadata.expiresAt': '' }, $set: { uploadDate: long } });
    const failed = await savePhoto('attendance-failed/665f00000000000000000001', 'attempt.jpg', photo(5));
    const enrolled = await savePhoto('enrollment', '665f000000000000000000aa.jpg', photo(9));
    const doc = await savePhoto('documents', 'offer-letter.pdf', Buffer.from('%PDF-1.4 test'));
    for (const ref of [failed, enrolled, doc]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await fileOf(ref)).metadata.expiresAt).toBeUndefined();
      // eslint-disable-next-line no-await-in-loop
      await filesCol().updateOne({ filename: nameOf(ref) }, { $set: { uploadDate: long } });
    }
    // Even with an expiry forced onto them, files outside attendance/ are not eligible.
    await setExpiry(failed, long);
    await setExpiry(enrolled, long);
    // One genuinely expired attendance photo, so the job has real work to do.
    await punch(worker, 'in');
    const row = await Attendance.findById(worker.rowId);
    await setExpiry(row.checkInPhotoRef, new Date(Date.now() - HOUR));

    const total = await filesCol().countDocuments({});
    expect(await purgeExpiredAttendancePhotos()).toMatchObject({ deleted: 1, failed: 0 });
    expect(await filesCol().countDocuments({})).toBe(total - 1);
    for (const ref of [legacy, failed, enrolled, doc]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await readPhoto(ref), ref).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      expect(await chunkCount(ref)).toBeGreaterThan(0);
    }
    // The legacy photo is still served: no expiry applies to it.
    expect(await attendancePhotoExpiry(legacy)).toBeNull();
    expect(await FaceDescriptor.countDocuments({})).toBe(2);
  });

  it('a photo with an expiry still in the future, even among expired ones', async () => {
    await punch(worker, 'in');
    await punch(hr, 'in');
    const a = await Attendance.findById(worker.rowId);
    const b = await Attendance.findById(hr.rowId);
    await setExpiry(a.checkInPhotoRef, new Date(Date.now() - 1000));
    await setExpiry(b.checkInPhotoRef, new Date(Date.now() + 1000));
    expect(await purgeExpiredAttendancePhotos()).toMatchObject({ deleted: 1 });
    expect(await fileOf(a.checkInPhotoRef)).toBeNull();
    expect(await fileOf(b.checkInPhotoRef)).toBeTruthy();
  });
});

describe('the cleanup can be triggered through the internal job endpoint', () => {
  const trigger = (headers = {}) => request(app).post('/api/v1/internal/jobs/attendance-photo-cleanup').set(headers);

  it('with the job token it runs the same cleanup; without it, it is refused', async () => {
    await punch(worker, 'in');
    const row = await Attendance.findById(worker.rowId);
    await setExpiry(row.checkInPhotoRef, new Date(Date.now() - 1000));

    expect((await trigger()).status).toBe(401);
    expect((await trigger({ 'X-Metrics-Token': 'wrong' })).status).toBe(401);
    expect((await trigger({ Authorization: `Bearer ${worker.token}` })).status).toBe(403);
    expect(await fileOf(row.checkInPhotoRef)).toBeTruthy();

    const ran = await trigger({ 'X-Metrics-Token': process.env.METRICS_TOKEN });
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ ok: true, via: 'token', result: { deleted: 1, failed: 0 } });
    expect(await fileOf(row.checkInPhotoRef)).toBeNull();
    expect((await trigger({ 'X-Metrics-Token': process.env.METRICS_TOKEN })).body.result.deleted).toBe(0);
  });
});
