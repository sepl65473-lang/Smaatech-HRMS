// Attendance punch-path coverage.
//
// Face matching itself is mocked here so these tests can drive the parts that
// were actually broken: the check-in/check-out concurrency race, the
// "HR punches their own row without a face check" bypass, mass assignment on
// the HR create route, and cross-employee access. Face/liveness maths has its
// own unit coverage in lib/liveness.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// A real, decodable JPEG so the upload filter and any decode path behave as
// they would in production; the descriptor extraction on top is mocked.
function makeJpeg(seed = 0) {
  const width = 160;
  const height = 160;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 7 + seed * 31) % 256;
    data[i * 4 + 1] = (i * 13 + seed * 17) % 256;
    data[i * 4 + 2] = (i * 3 + seed * 53) % 256;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 80).data;
}

const ENROLLED = Array(128).fill(0.1);

vi.mock('../lib/faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Always "sees" the enrolled face, so the tests exercise the surrounding
    // authorization/concurrency logic rather than the model.
    extractDescriptor: vi.fn(async () => ({ descriptor: Array(128).fill(0.1) })),
    extractFaceData: vi.fn(async () => ({ descriptor: Array(128).fill(0.1), geometry: {}, stats: {} })),
  };
});

vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn(async () => 'Test Area, Bengaluru, Karnataka - 560001') }));

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
const COMPANY = 'CompanyA';

async function ensureRoles() {
  for (const name of ['HR Manager', 'HR Director', 'Employee']) {
    if (!(await Role.findOne({ name }))) {
      await Role.create({ name, allowedPaths: ['/attendance'], allowedActions: name === 'Employee' ? [] : ['manageAttendance'] });
    }
  }
}

let seq = 0;
async function seedPerson(role = 'Employee', { enrollFace = true, company = COMPANY } = {}) {
  seq += 1;
  const emp = await Employee.create({ name: `Person ${seq}`, role, dept: 'Engineering', company });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `person${seq}@example.com`;
  const user = await User.create({ name: emp.name, email, passwordHash, role, company, employeeId: emp._id, active: true });
  if (enrollFace) await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.accessToken, emp, user };
}

async function rowFor(emp) {
  return Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date: todayISO(), company: emp.company });
}

function checkIn(rowId, token, { photo = true } = {}) {
  const req = request(app).post(`/api/v1/attendance/${rowId}/check-in`).set('Authorization', `Bearer ${token}`);
  if (photo) req.attach('photo', makeJpeg(seq), { filename: 'p.jpg', contentType: 'image/jpeg' });
  return req;
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY, twoFactor: false, gpsCheckInEnabled: false });
  await ensureRoles();
});

describe('GET /attendance — filtering', () => {
  it('HONOURS ?date= without paging parameters', async () => {
    const hr = await seedPerson('HR Manager');
    const { emp } = await seedPerson('Employee');

    await Attendance.create({
      empId: emp._id, name: emp.name, dept: emp.dept,
      date: '2026-03-02', status: 'present', checkIn: '09:15', company: COMPANY,
    });
    await Attendance.create({
      empId: emp._id, name: emp.name, dept: emp.dept,
      date: '2026-03-03', status: 'absent', company: COMPANY,
    });

    // The unpaged branch used to build no filter at all, so a caller asking
    // for one day silently received the 100 most recent rows instead.
    const res = await request(app).get('/api/v1/attendance?date=2026-03-02')
      .set('Authorization', `Bearer ${hr.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].date).toBe('2026-03-02');
    expect(res.body[0].checkIn).toBe('09:15');
  });

  it('honours ?from=/?to= without paging parameters', async () => {
    const hr = await seedPerson('HR Manager');
    const { emp } = await seedPerson('Employee');
    for (const date of ['2026-03-01', '2026-03-05', '2026-04-01']) {
      // eslint-disable-next-line no-await-in-loop
      await Attendance.create({
        empId: emp._id, name: emp.name, dept: emp.dept,
        date, status: 'present', company: COMPANY,
      });
    }

    const res = await request(app).get('/api/v1/attendance?from=2026-03-01&to=2026-03-31')
      .set('Authorization', `Bearer ${hr.token}`);

    expect(res.body.map((r) => r.date).sort()).toEqual(['2026-03-01', '2026-03-05']);
  });
});

describe('attendance row bootstrap', () => {
  it("auto-creates today's attendance row on GET /attendance if missing", async () => {
    const { token, emp } = await seedPerson('HR Manager');
    await Attendance.deleteMany({ empId: emp._id });

    const res = await request(app).get('/api/v1/attendance').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.find((a) => a.empId === String(emp._id) && a.date === todayISO());
    expect(row).toBeDefined();
    expect(row.status).toBe('absent');
    expect(row.checkIn).toBeNull();
  });
});

describe('punch ordering', () => {
  it('rejects checking out before checking in', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);

    const out = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', makeJpeg(1), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(out.status).toBe(400);
    expect(out.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('rejects a duplicate check-in', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);

    const first = await checkIn(row.id, token);
    expect(first.status).toBe(200);
    expect(first.body.checkIn).toBeTruthy();

    const second = await checkIn(row.id, token);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_IN');
  });
});

describe('CONCURRENT punches', () => {
  it('records exactly one check-in when several arrive at once', async () => {
    // The old handler read the row, then ran face extraction and a reverse
    // geocode (hundreds of ms) before a blind findByIdAndUpdate. Two requests
    // overlapping in that window both passed the "already checked in?" guard
    // and both wrote — two audited check-ins for one employee-day, the second
    // photo silently overwriting the first.
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);

    const results = await Promise.all(Array.from({ length: 5 }, () => checkIn(row.id, token)));
    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(4);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkIn).toBeTruthy();
    expect(stored.checkOut).toBeNull();
  });

  it('records exactly one check-out when several arrive at once', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    await checkIn(row.id, token);

    const results = await Promise.all(Array.from({ length: 5 }, () => request(app)
      .post(`/api/v1/attendance/${row.id}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', makeJpeg(2), { filename: 'p.jpg', contentType: 'image/jpeg' })));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });
});

describe('self-service verification applies to EVERY role', () => {
  it('requires a face photo when an HR Manager punches their OWN row', async () => {
    // This was the bypass: `isSelfService = !isAdmin` meant an HR Manager or
    // HR Director could mark THEMSELVES present from anywhere, with no face
    // match and no geofence check, while every other employee was verified.
    const { token, emp } = await seedPerson('HR Manager');
    const row = await rowFor(emp);

    const res = await checkIn(row.id, token, { photo: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PHOTO');

    const stored = await Attendance.findById(row.id);
    expect(stored.checkIn).toBeNull();
  });

  it('requires an enrolled face when an HR Director punches their OWN row', async () => {
    const { token, emp } = await seedPerson('HR Director', { enrollFace: false });
    const row = await rowFor(emp);

    const res = await checkIn(row.id, token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_ENROLLED');
  });

  it('still allows an audited HR override on ANOTHER employee row', async () => {
    // Genuine HR corrections must keep working — they are a different action
    // from punching your own attendance, and are recorded as such.
    const { token: hrToken } = await seedPerson('HR Manager');
    const { emp: other } = await seedPerson('Employee');
    const row = await rowFor(other);

    const res = await checkIn(row.id, hrToken, { photo: false });
    expect(res.status).toBe(200);
    expect(res.body.checkInDetails).toBe('HR Manual Punch');
    expect(res.body.checkInDeviceId).toBe('HR-Console');
  });

  it('records liveness as unverified rather than claiming it', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    const res = await checkIn(row.id, token);

    expect(res.status).toBe(200);
    // The server must never store a liveness claim it did not make.
    expect(res.body.checkInVerification.liveness.verified).toBe(false);
    expect(res.body.checkInVerification.liveness.reason).toBe('not-required-by-policy');
    expect(res.body.checkInDetails).toBe('Face Verified');
  });

  it('records total working hours on check-out, and derives them for older rows', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    await checkIn(row.id, token);
    await Attendance.updateOne({ _id: row.id }, { checkIn: '09:15' });

    const out = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-out`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', makeJpeg(seq), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(out.status).toBe(200);
    expect(out.body.workedMinutes).toBeGreaterThan(0);
    const stored = await Attendance.findById(row.id);
    expect(stored.workedMinutes).toBe(out.body.workedMinutes);

    // A row written before this field existed keeps null in the database and
    // is derived on read, so no historical record is rewritten.
    await Attendance.updateOne({ _id: row.id }, { checkIn: '09:15', checkOut: '18:00', workedMinutes: null });
    const list = await request(app).get('/api/v1/attendance').set('Authorization', `Bearer ${token}`);
    const listed = list.body.find((r) => r.id === String(row.id));
    expect(listed.workedMinutes).toBe(525);
    expect(await Attendance.findById(row.id).then((r) => r.workedMinutes)).toBeNull();
  });

  it('records GPS as unevaluated rather than claiming a geofence pass when geofencing is off', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    const res = await checkIn(row.id, token)
      .field('lat', '12.97160')
      .field('lng', '77.59460')
      .field('accuracy', '10')
      .field('timestamp', String(Date.now()));

    expect(res.status).toBe(200);
    // Previously { inside: true, distance: 0 }: evidence of a check that never ran.
    expect(res.body.checkInVerification.gps).toEqual({ evaluated: false, reason: 'geofence-disabled' });
    expect(res.body.checkInDetails).toBe('Face Verified + GPS Recorded');
    expect(res.body.checkInLoc).toBe('12.97160, 77.59460');
  });

  it('blocks punching another employee row as a plain Employee', async () => {
    const { token } = await seedPerson('Employee');
    const { emp: victim } = await seedPerson('Employee');
    const row = await rowFor(victim);

    const res = await checkIn(row.id, token);
    expect(res.status).toBe(403);
  });
});

describe('liveness enforcement when enabled', () => {
  beforeEach(async () => {
    await Settings.findByIdAndUpdate(COMPANY, { livenessRequired: true });
  });

  it('rejects a single still photo with no challenge', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);

    const res = await checkIn(row.id, token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(await Attendance.findById(row.id).then((r) => r.checkIn)).toBeNull();
  });

  it('issues an unpredictable, single-use challenge', async () => {
    const { token } = await seedPerson('Employee');
    const a = await request(app).get('/api/v1/attendance/liveness/challenge').set('Authorization', `Bearer ${token}`);
    const b = await request(app).get('/api/v1/attendance/liveness/challenge').set('Authorization', `Bearer ${token}`);

    expect(a.status).toBe(200);
    expect(['turn-left', 'turn-right', 'blink']).toContain(a.body.action);
    expect(a.body.challengeId).not.toBe(b.body.challengeId);
    expect(a.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a challenge id that was already used', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    const challenge = await request(app).get('/api/v1/attendance/liveness/challenge').set('Authorization', `Bearer ${token}`);

    const attempt = () => request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${token}`)
      .field('challengeId', challenge.body.challengeId)
      .attach('frames', makeJpeg(1), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('frames', makeJpeg(2), { filename: 'b.jpg', contentType: 'image/jpeg' })
      .attach('frames', makeJpeg(3), { filename: 'c.jpg', contentType: 'image/jpeg' });

    await attempt();
    const replay = await attempt();
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('CHALLENGE_EXPIRED');
  });
});

describe('HR attendance create route', () => {
  it('cannot fabricate a verified punch through the request body', async () => {
    // The old handler spread req.body straight into Attendance.create, so a
    // caller could set checkInPhotoRef / checkInVerification /
    // checkInFaceConfidence directly and manufacture a record that reads as
    // "Face + GPS Verified" with no face and no GPS in the request at all.
    const { token: hrToken } = await seedPerson('HR Manager');
    const { emp } = await seedPerson('Employee');

    const res = await request(app)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        empId: String(emp._id),
        date: todayISO(),
        name: emp.name,
        status: 'present',
        checkIn: '09:00',
        checkInVerification: { face: { matched: true, confidence: 100 } },
        checkInFaceConfidence: 100,
        checkInPhotoRef: '../../etc/passwd',
        company: 'OtherCo',
      });

    expect(res.status).toBe(201);
    expect(res.body.checkInVerification).toBeNull();
    expect(res.body.checkInFaceConfidence).toBeNull();
    expect(res.body.checkInPhotoRef).toBeNull();
    expect(res.body.company).toBe(COMPANY);
    expect(res.body.checkInDetails).toBe('HR Manual Entry');
  });

  it('returns 409 rather than 500 for a duplicate employee-day row', async () => {
    const { token: hrToken } = await seedPerson('HR Manager');
    const { emp } = await seedPerson('Employee');
    await rowFor(emp);

    const res = await request(app)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ empId: String(emp._id), date: todayISO(), name: emp.name, status: 'present' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTENDANCE_EXISTS');
  });

  it('refuses an employee from another company', async () => {
    const { token: hrToken } = await seedPerson('HR Manager');
    const foreign = await Employee.create({ name: 'Outsider', company: 'OtherCo' });

    const res = await request(app)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ empId: String(foreign._id), date: todayISO(), status: 'present' });
    expect(res.status).toBe(404);
  });
});

describe('reading a single attendance row', () => {
  it('404s instead of returning 200 with null', async () => {
    const { token } = await seedPerson('HR Manager');
    const res = await request(app)
      .get('/api/v1/attendance/000000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("hides another employee's row (with its GPS, IP and device data) from a peer", async () => {
    const { token } = await seedPerson('Employee');
    const { emp: other } = await seedPerson('Employee');
    const row = await rowFor(other);

    const res = await request(app).get(`/api/v1/attendance/${row.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('lets an employee read their own row', async () => {
    const { token, emp } = await seedPerson('Employee');
    const row = await rowFor(emp);
    const res = await request(app).get(`/api/v1/attendance/${row.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(String(row._id));
  });
});

describe('attendance summary aggregation', () => {
  // The summary used to load every matching row into Node and sum in a JS
  // loop. It now groups in MongoDB. These pin the exact counting semantics so
  // the rewrite cannot drift — half-day counting as BOTH half present and half
  // absent is the easiest part to get wrong.
  async function seedSummaryRows() {
    const { emp } = await seedPerson('Employee');
    const mk = (date, status, dept = 'Engineering') => Attendance.create({
      empId: emp._id, name: emp.name, dept, date, status, company: COMPANY,
    });
    await mk('2026-06-01', 'present');
    await mk('2026-06-02', 'present');
    await mk('2026-06-03', 'late');
    await mk('2026-06-04', 'absent');
    await mk('2026-06-05', 'early-exit');
    await mk('2026-06-06', 'half-day');
    // Excluded: scheduled absences are not attendance behaviour.
    await mk('2026-06-07', 'holiday');
    await mk('2026-06-08', 'leave');
    // A second department, and one row with no dept at all.
    await mk('2026-06-09', 'present', 'Sales');
    await Attendance.create({
      empId: emp._id, name: emp.name, date: '2026-06-10', status: 'present', company: COMPANY,
    });
    return emp;
  }

  it('counts each status into the right bucket, per department', async () => {
    const { token } = await seedPerson('HR Manager');
    await seedSummaryRows();

    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const byDept = Object.fromEntries(res.body.rows.map((r) => [r.dept, r]));

    // Engineering: 2 present, 1 late, 1 absent, 1 early-exit, 1 half-day.
    expect(byDept.Engineering.present).toBe(2.5); // 2 + half of the half-day
    expect(byDept.Engineering.late).toBe(1);
    expect(byDept.Engineering.absent).toBe(2.5); // absent + early-exit + half
    expect(byDept.Sales).toEqual({ dept: 'Sales', present: 1, late: 0, absent: 0 });
  });

  it("buckets a row with no department under 'Unassigned'", async () => {
    const { token } = await seedPerson('HR Manager');
    await seedSummaryRows();

    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${token}`);
    const unassigned = res.body.rows.find((r) => r.dept === 'Unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned.present).toBe(1);
  });

  it('excludes holidays and approved leave from attendance behaviour', async () => {
    const { token } = await seedPerson('HR Manager');
    await seedSummaryRows();

    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${token}`);
    const total = res.body.rows.reduce((sum, r) => sum + r.present + r.late + r.absent, 0);
    // 8 counted rows (2 holiday/leave rows excluded from the 10 seeded).
    expect(total).toBe(8);
  });

  it('honours the date range boundaries', async () => {
    const { token } = await seedPerson('HR Manager');
    await seedSummaryRows();

    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2026-06-01&to=2026-06-02')
      .set('Authorization', `Bearer ${token}`);
    const eng = res.body.rows.find((r) => r.dept === 'Engineering');
    expect(eng.present).toBe(2);
    expect(eng.late).toBe(0);
  });

  it('returns an empty row set rather than failing when nothing matches', async () => {
    const { token } = await seedPerson('HR Manager');
    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2030-01-01&to=2030-01-31')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('scopes a plain employee to their own rows only', async () => {
    const { token: peerToken } = await seedPerson('Employee');
    await seedSummaryRows(); // belongs to a different employee

    const res = await request(app)
      .get('/api/v1/attendance/summary?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${peerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });
});
