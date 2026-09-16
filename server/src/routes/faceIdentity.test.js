// THE identity requirement, stated as tests.
//
//   "The face MUST match the registered face of that exact account.
//    Wrong credentials + wrong face = REJECT.
//    Correct credentials + another employee's face = REJECT."
//
// The second line is the one that matters and the one a backend test suite
// usually misses: an attacker who has a colleague's password does not need to
// defeat the face model, they only need the server to compare against the
// WRONG enrolled template — the roster at large, the employee named in the
// request body, or nobody at all. These tests pin the comparison to the
// signed-in account's own template and prove the rejection is recorded with
// evidence.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// Two distinct, stable "faces". ALICE_FACE and BOB_FACE are far apart in
// descriptor space, well beyond the 0.5 match threshold.
const ALICE_FACE = Array(128).fill(0.10);
const BOB_FACE = Array(128).fill(0.90);

// The descriptor the mocked model "sees" in whatever photo was uploaded.
let presentedFace = ALICE_FACE;

vi.mock('../lib/faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractDescriptor: vi.fn(async () => ({ descriptor: presentedFace })),
    extractFaceData: vi.fn(async () => ({
      descriptor: presentedFace,
      geometry: { leftEyeRatio: 0.3, rightEyeRatio: 0.3, yaw: 0, faceAreaRatio: 0.25 },
      stats: { variance: 900 },
    })),
  };
});

vi.mock('../lib/geocode.js', () => ({
  reverseGeocode: vi.fn(async (lat, lng, opts = {}) => ({
    placeName: 'Smaatech Engineering',
    fullAddress: 'Smaatech Engineering, 12 MG Road, Indiranagar, Bengaluru, Karnataka, India',
    pincode: '560038',
    area: 'Indiranagar',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    state: 'Karnataka',
    country: 'India',
    lat, lng, accuracy: opts.accuracy ?? null,
    source: 'nominatim',
    resolvedAt: new Date().toISOString(),
    display: 'Smaatech Engineering, 12 MG Road, Indiranagar, Bengaluru, Karnataka, India - 560038',
  })),
  reverseGeocodeLine: vi.fn(async () => 'Bengaluru, Karnataka - 560038'),
  structureAddress: vi.fn(() => ({})),
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
const Attendance = (await import('../models/Attendance.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const VerificationAttempt = (await import('../models/VerificationAttempt.js')).default;
const Role = (await import('../models/Role.js')).default;
const { todayISO } = await import('../lib/dateUtils.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'FaceCo';

// Inside the default geofence (19.0760, 72.8777) used by Settings.
const AT_OFFICE = { lat: 19.0760, lng: 72.8777, accuracy: 10 };

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

async function ensureRoles() {
  for (const name of ['HR Manager', 'HR Director', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, allowedActions: name === 'Employee' ? [] : ['manageAttendance'] });
    }
  }
}

async function seedPerson(key, role, faceDescriptor) {
  const emp = await Employee.create({
    name: key, role: 'Engineer', dept: 'Engineering', loc: 'Bengaluru', company: COMPANY,
  });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key.toLowerCase()}@example.com`;
  const user = await User.create({
    name: key, email, passwordHash, role, company: COMPANY, active: true, employeeId: emp._id,
  });
  if (faceDescriptor) await FaceDescriptor.create({ userId: user._id, descriptor: faceDescriptor });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { emp, user, token: login.body.accessToken, email };
}

let alice; let bob; let hr;

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  presentedFace = ALICE_FACE;
  await Settings.create({ _id: COMPANY, twoFactor: false, gpsCheckInEnabled: true });
  await ensureRoles();
  alice = await seedPerson('Alice', 'Employee', ALICE_FACE);
  bob = await seedPerson('Bob', 'Employee', BOB_FACE);
  hr = await seedPerson('HRPerson', 'HR Manager', null);
});

function rowFor(person) {
  return Attendance.create({
    empId: person.emp._id, name: person.emp.name, dept: 'Engineering',
    date: todayISO(), company: COMPANY,
  });
}

function punch(rowId, token, { seed = 1, ...coords } = {}) {
  const req = request(app)
    .post(`/api/v1/attendance/${rowId}/check-in`)
    .set('Authorization', `Bearer ${token}`)
    .field('deviceId', 'browser-test-device');
  for (const [k, v] of Object.entries({ ...AT_OFFICE, ...coords })) req.field(k, String(v));
  return req.attach('photo', makeJpeg(seed), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
}

describe('the face must match the signed-in account', () => {
  it('ACCEPTS Alice signed in as Alice presenting her own face', async () => {
    const row = await rowFor(alice);
    presentedFace = ALICE_FACE;

    const res = await punch(row.id, alice.token);
    expect(res.status).toBe(200);
    expect(res.body.checkIn).toBeTruthy();
    expect(res.body.checkInVerification.face.matched).toBe(true);
  });

  it("REJECTS Alice's valid login presenting BOB's face", async () => {
    // The buddy-punching case: real credentials, someone else in front of the
    // camera. The server compares against the SIGNED-IN account's template,
    // so this must fail even though the login was entirely legitimate.
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;

    const res = await punch(row.id, alice.token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FACE_NOT_MATCHED');

    const stored = await Attendance.findById(row.id);
    expect(stored.checkIn).toBeNull();
    expect(stored.status).toBe('absent');
  });

  it("REJECTS Bob's valid login presenting ALICE's face", async () => {
    // Symmetric: the check is not accidentally passing for one direction only.
    const row = await rowFor(bob);
    presentedFace = ALICE_FACE;

    const res = await punch(row.id, bob.token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FACE_NOT_MATCHED');
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });

  it('rejects an account with no enrolled face rather than letting it through', async () => {
    const row = await rowFor(hr);
    const res = await punch(row.id, hr.token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_ENROLLED');
  });

  it('rejects an invalid token outright — no face processing at all', async () => {
    const row = await rowFor(alice);
    const res = await punch(row.id, 'not-a-real-token');
    expect(res.status).toBe(401);
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });

  it('rejects a deactivated account even with a face that would match', async () => {
    const row = await rowFor(alice);
    presentedFace = ALICE_FACE;
    await User.updateOne({ _id: alice.user._id }, { active: false });

    const res = await punch(row.id, alice.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('rejections are recorded as evidence, not just refused', () => {
  it('stores the rejected attempt with reason, distance and the capture', async () => {
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);

    const attempts = await VerificationAttempt.find({ company: COMPANY });
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;

    expect(attempt.stage).toBe('face');
    expect(attempt.reasonCode).toBe('FACE_NOT_MATCHED');
    // The account that was signed in — this is what makes
    // "correct password, wrong face" reconstructable afterwards.
    expect(String(attempt.userId)).toBe(String(alice.user._id));
    expect(String(attempt.empId)).toBe(String(alice.emp._id));
    expect(attempt.faceDistance).toBeGreaterThan(0.5);
    // The photo itself is retained as evidence.
    expect(attempt.photoRef).toBeTruthy();
    expect(attempt.direction).toBe('in');
  });

  it('records WHERE the rejected attempt happened', async () => {
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);

    const attempt = await VerificationAttempt.findOne({ company: COMPANY });
    expect(attempt.location.city).toBe('Bengaluru');
    expect(attempt.location.pincode).toBe('560038');
    expect(attempt.location.lat).toBeCloseTo(AT_OFFICE.lat, 3);
    expect(attempt.device).toBeTruthy();
    expect(attempt.deviceId).toBe('browser-test-device');
  });

  it('surfaces the failure count on the attendance row itself', async () => {
    // So HR sees "2 failed attempts" on the record, without needing the audit
    // log — which only an HR Director can open.
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);
    await punch(row.id, alice.token);

    const stored = await Attendance.findById(row.id);
    expect(stored.failedVerificationCount).toBe(2);
    expect(stored.anomalyFlags).toContain('failed-verification');
  });

  it('records a geofence rejection with the distance from the office', async () => {
    const row = await rowFor(alice);
    // Far outside the configured radius.
    const res = await punch(row.id, alice.token, { lat: 28.6139, lng: 77.2090 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');

    const attempt = await VerificationAttempt.findOne({ company: COMPANY, stage: 'geofence' });
    expect(attempt).toBeTruthy();
    expect(attempt.location.distanceFromOffice).toBeGreaterThan(1000);
  });

  it('slows down repeated rejections instead of allowing unlimited retries', async () => {
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;

    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      lastStatus = (await punch(row.id, alice.token)).status;
    }
    expect(lastStatus).toBe(429);
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });
});

describe('HR verification dossier', () => {
  it('returns identity, photo, structured location, device and failed attempts', async () => {
    const row = await rowFor(alice);

    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);     // one rejected attempt
    presentedFace = ALICE_FACE;
    const ok = await punch(row.id, alice.token); // then a genuine punch
    expect(ok.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/attendance/${row.id}/verification`)
      .set('Authorization', `Bearer ${hr.token}`);
    expect(res.status).toBe(200);

    // Employee identity
    expect(res.body.employee.name).toBe('Alice');
    expect(res.body.employee.id).toBe(String(alice.emp._id));

    // Verification result + retained photo
    expect(res.body.checkIn.verification.face.matched).toBe(true);
    expect(res.body.checkIn.photoUrl).toContain(`/api/v1/files/attendance/${row.id}/checkIn`);
    expect(res.body.checkIn.time).toBeTruthy();

    // Location: name + full address + PIN + coordinates, all separately
    expect(res.body.checkIn.location.placeName).toBe('Smaatech Engineering');
    expect(res.body.checkIn.location.fullAddress).toContain('Bengaluru');
    expect(res.body.checkIn.location.pincode).toBe('560038');
    expect(res.body.checkIn.location.lat).toBeCloseTo(AT_OFFICE.lat, 3);
    expect(res.body.checkIn.location.lng).toBeCloseTo(AT_OFFICE.lng, 3);
    expect(res.body.checkIn.coordinates).toMatch(/^19\.07/);

    // Device
    expect(res.body.checkIn.deviceId).toBe('browser-test-device');
    expect(res.body.checkIn.device).toBeTruthy();

    // Failed attempts, with their own evidence photo
    expect(res.body.failedVerificationCount).toBe(1);
    expect(res.body.failedAttempts).toHaveLength(1);
    expect(res.body.failedAttempts[0].reasonCode).toBe('FACE_NOT_MATCHED');
    expect(res.body.failedAttempts[0].photoUrl).toContain('/api/v1/files/verification-attempt/');
    // The storage path is never exposed.
    expect(res.body.failedAttempts[0].photoRef).toBeUndefined();
  });

  it('is NOT readable by a plain employee, not even for their own row', async () => {
    const row = await rowFor(alice);
    const res = await request(app)
      .get(`/api/v1/attendance/${row.id}/verification`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(403);
  });

  it('serves the rejected-attempt photo only to HR', async () => {
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);
    const attempt = await VerificationAttempt.findOne({ company: COMPANY });

    const asEmployee = await request(app)
      .get(`/api/v1/files/verification-attempt/${attempt._id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(asEmployee.status).toBe(403);

    const asHR = await request(app)
      .get(`/api/v1/files/verification-attempt/${attempt._id}`)
      .set('Authorization', `Bearer ${hr.token}`);
    expect(asHR.status).toBe(200);
    expect(asHR.headers['content-type']).toContain('image/');
    expect(asHR.headers['cache-control']).toContain('no-store');
  });

  it('does not leak another company attempts', async () => {
    const row = await rowFor(alice);
    presentedFace = BOB_FACE;
    await punch(row.id, alice.token);
    const attempt = await VerificationAttempt.findOne({ company: COMPANY });
    await VerificationAttempt.updateOne({ _id: attempt._id }, { company: 'RivalCo' });

    const res = await request(app)
      .get(`/api/v1/files/verification-attempt/${attempt._id}`)
      .set('Authorization', `Bearer ${hr.token}`);
    expect(res.status).toBe(404);
  });
});

describe('HR override is recorded as an override, never as a face match', () => {
  it('an HR punch on someone else row claims no biometric verification', async () => {
    const row = await rowFor(alice);
    const res = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${hr.token}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.checkInDetails).toBe('HR Manual Punch');
    // The decisive assertion: an HR override must never look like a verified
    // biometric punch in the record.
    expect(res.body.checkInVerification.face).toBeNull();
    expect(res.body.checkInVerification.liveness.verified).toBe(false);
    expect(res.body.checkInVerification.liveness.reason).toBe('hr-override');
    expect(res.body.checkInFaceConfidence).toBeNull();
  });

  it('HR punching their OWN row is verified like anyone else — no self-bypass', async () => {
    // With no location at all, the geofence check refuses first — HR is not
    // exempt from that either.
    const row = await rowFor(hr);
    const bare = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${hr.token}`)
      .send();
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('NO_COORDINATES');
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();

    // Supply a valid in-office location and it still demands a face.
    const withLocation = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${hr.token}`)
      .field('lat', String(AT_OFFICE.lat))
      .field('lng', String(AT_OFFICE.lng))
      .field('accuracy', String(AT_OFFICE.accuracy));
    expect(withLocation.status).toBe(400);
    expect(withLocation.body.error.code).toBe('NO_PHOTO');
    expect((await Attendance.findById(row.id)).checkIn).toBeNull();
  });
});
