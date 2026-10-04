// The temporary face-verification lock: an exact, server-given wait, and an
// HR/Admin reset for one named account that lets the person TRY again without
// letting anyone pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const ENROLLED = Array(128).fill(0.1);
const STRANGER = Array(128).fill(0.9);
const face = vi.hoisted(() => ({ result: null }));
vi.mock('../lib/faceEngine.js', async (importOriginal) => ({
  ...(await importOriginal()),
  extractDescriptor: vi.fn(async () => face.result),
}));
vi.mock('../lib/shifts.js', async (importOriginal) => ({ ...(await importOriginal()), nowTimeIST: () => '09:30' }));
vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn(async () => ({ display: 'Test Area, Bengaluru' })) }));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const VerificationAttempt = (await import('../models/VerificationAttempt.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'Smaatech';

function photo() {
  const size = 160; const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) { data[i * 4] = (i * 7) % 256; data[i * 4 + 1] = (i * 13) % 256; data[i * 4 + 2] = (i * 3) % 256; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: size, height: size }, 80).data;
}

let seq = 0;
async function seed(role = 'Employee') {
  seq += 1;
  const emp = await Employee.create({ name: `${role} ${seq}`, dept: 'Engineering', company: COMPANY, email: `lock${seq}@example.com` });
  const user = await User.create({ name: emp.name, email: emp.email, passwordHash: await bcrypt.hash(PASSWORD, 10), role, company: COMPANY, employeeId: emp._id, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
  const login = await request(app).post('/api/v1/auth/login').send({ email: emp.email, password: PASSWORD });
  const row = await Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: COMPANY });
  return { emp, user, token: login.body.accessToken, rowId: String(row._id), userId: String(user._id) };
}

const checkIn = (p) => request(app).post(`/api/v1/attendance/${p.rowId}/check-in`).set('Authorization', `Bearer ${p.token}`)
  .field('lat', '12.9716').field('lng', '77.5946').field('accuracy', '10')
  .attach('photo', photo(), { filename: 'p.jpg', contentType: 'image/jpeg' });
const lockOf = (token, query = '') => request(app).get(`/api/v1/attendance/verification-lock${query}`).set('Authorization', `Bearer ${token}`);
const reset = (token, body) => request(app).post('/api/v1/attendance/verification-lock/reset').set('Authorization', `Bearer ${token}`).send(body);

async function failTimes(person, n) {
  face.result = { descriptor: STRANGER };
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await checkIn(person);
    expect(res.body.error.code).toBe('FACE_NOT_MATCHED');
  }
}

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => {
  await clearTestDB();
  face.result = { descriptor: ENROLLED };
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, livenessRequired: false });
  for (const name of ['HR Director', 'HR Manager', 'Finance Lead', 'Employee']) {
    await Role.create({ name, allowedActions: name.startsWith('HR') ? ['manageAttendance'] : [] });
  }
});

describe('lockout and the exact wait', () => {
  it('seven failures do not lock; the eighth does, and the server says exactly how long', async () => {
    const person = await seed();
    await failTimes(person, 7);
    expect((await lockOf(person.token)).body).toMatchObject({ locked: false, failedAttempts: 7, retryAt: null });

    await failTimes(person, 1);
    const state = await lockOf(person.token);
    expect(state.body.locked).toBe(true);
    expect(state.body.remainingSeconds).toBeGreaterThan(14 * 60);
    expect(state.body.remainingSeconds).toBeLessThanOrEqual(15 * 60);
    expect(new Date(state.body.retryAt).getTime()).toBeGreaterThan(Date.now());

    // The ninth attempt — with the CORRECT face — is refused while locked.
    face.result = { descriptor: ENROLLED };
    const refused = await checkIn(person);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('TOO_MANY_FAILED_ATTEMPTS');
    expect(refused.body.error.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(refused.body.error.retryAt).toBe(state.body.retryAt);
    expect(Number(refused.headers['retry-after'])).toBe(refused.body.error.retryAfterSeconds);
    expect(refused.body.error.message).toMatch(/You can try again in 1[45] minutes? \d+ seconds?/);
    expect(refused.body.error.message).toMatch(/HR\/Admin/);
    expect((await Attendance.findById(person.rowId)).checkIn).toBeNull();
  });

  it('retrying while locked does not push the release time further away', async () => {
    const person = await seed();
    await failTimes(person, 8);
    const first = (await lockOf(person.token)).body.retryAt;
    face.result = { descriptor: ENROLLED };
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await checkIn(person)).status).toBe(429);
    }
    expect((await lockOf(person.token)).body.retryAt).toBe(first);
  });

  it('releases by itself once the eighth most recent failure is 15 minutes old', async () => {
    const person = await seed();
    await failTimes(person, 8);
    // Age every failure past the window: the server's clock decides, not the client's.
    await VerificationAttempt.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 16 * 60 * 1000) } });
    expect((await lockOf(person.token)).body.locked).toBe(false);
    face.result = { descriptor: ENROLLED };
    const ok = await checkIn(person);
    expect(ok.status).toBe(200);
  });
});

describe('HR/Admin reset', () => {
  it('unlocks only the named employee, is audited, and does not bypass verification', async () => {
    const locked = await seed();
    const alsoLocked = await seed();
    const hr = await seed('HR Manager');
    await failTimes(locked, 8);
    await failTimes(alsoLocked, 8);

    // HR can see the state before acting.
    const seen = await lockOf(hr.token, `?email=${encodeURIComponent(locked.emp.email)}`);
    expect(seen.body).toMatchObject({ locked: true, name: locked.emp.name });

    const done = await reset(hr.token, { email: locked.emp.email, reason: 'Poor lighting at the gate' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ locked: false, failedAttempts: 0, userId: locked.userId });

    const audit = await AuditLog.findOne({ action: 'Face verification lock reset' });
    expect(audit.subject).toBe(locked.emp.name);
    expect(audit.actor.name).toBe(hr.emp.name);
    expect(audit.details).toContain('Poor lighting at the gate');

    // The other employee is untouched.
    expect((await lockOf(alsoLocked.token)).body.locked).toBe(true);
    // The evidence is kept.
    expect(await VerificationAttempt.countDocuments({ userId: locked.userId })).toBe(8);

    // Unlocked means "may try again", not "passes": a wrong face still fails…
    face.result = { descriptor: STRANGER };
    const wrong = await checkIn(locked);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('FACE_NOT_MATCHED');
    // …and the right face goes through the normal check and succeeds.
    face.result = { descriptor: ENROLLED };
    const ok = await checkIn(locked);
    expect(ok.status).toBe(200);
    expect(ok.body.checkInDetails).toContain('Face');
  });

  it('is refused for employees, other roles, self, and without a session', async () => {
    const locked = await seed();
    const colleague = await seed();
    const finance = await seed('Finance Lead');
    const hr = await seed('HR Manager');
    await failTimes(locked, 8);

    expect((await reset(locked.token, { userId: locked.userId })).status).toBe(403);     // self
    expect((await reset(colleague.token, { userId: locked.userId })).status).toBe(403);  // another employee
    expect((await reset(finance.token, { userId: locked.userId })).status).toBe(403);    // wrong role
    expect((await request(app).post('/api/v1/attendance/verification-lock/reset').send({ userId: locked.userId })).status).toBe(401);
    expect((await lockOf(colleague.token, `?userId=${locked.userId}`)).status).toBe(403); // cannot even look
    expect((await lockOf(locked.token)).body.locked).toBe(true);

    // HR cannot release their own lock, and a bad or missing target unlocks nobody.
    const selfReset = await reset(hr.token, { userId: hr.userId });
    expect(selfReset.status).toBe(403);
    expect(selfReset.body.error.code).toBe('SELF_RESET_FORBIDDEN');
    expect((await reset(hr.token, {})).status).toBe(404);
    expect((await reset(hr.token, { userId: 'not-an-id' })).status).toBe(404);
    expect((await lockOf(locked.token)).body.locked).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'Face verification lock reset' })).toBe(0);
  });
});
