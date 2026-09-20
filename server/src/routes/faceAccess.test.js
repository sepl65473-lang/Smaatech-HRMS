// HR/Admin-controlled face RE-verification access.
//
// The rule these pin: a first enrolment is self-service, exactly as before,
// but REPLACING an existing template — the step that decides whose face
// attendance will accept from then on — needs a grant from HR, for one
// account, with a reason, an expiry, and an audit trail. The grant is access
// to the normal enrolment flow; nothing about face detection or matching
// changes, and a granted employee still has to pass both.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// The real engine needs a decodable JPEG and a model; this suite is about
// authorisation, so extraction is stubbed to a fixed descriptor.
vi.mock('../lib/faceEngine.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractDescriptor: vi.fn(async () => ({ descriptor: Array(128).fill(0.1) })),
  };
});

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const FaceAccessGrant = (await import('../models/FaceAccessGrant.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'CompanyA';
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

async function seedUser(name, email, role = 'Employee') {
  await Settings.findOneAndUpdate({ _id: COMPANY }, {}, { upsert: true });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ name, email, passwordHash, role, company: COMPANY, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { user, token: login.body.accessToken };
}

const enrol = (token) => request(app)
  .post('/api/v1/face/enroll')
  .set('Authorization', `Bearer ${token}`)
  .attach('photo', photo, { filename: 'face.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Role.create({ name: 'HR Manager', permissions: ['*'], company: COMPANY });
});

describe('first-time enrolment is unchanged', () => {
  it('lets an employee with no template enrol themselves', async () => {
    const { user, token } = await seedUser('New Joiner', 'new@companya.com');
    const res = await enrol(token);

    expect(res.status).toBe(200);
    expect(await FaceDescriptor.findOne({ userId: user._id })).not.toBeNull();

    const me = await request(app).get('/api/v1/face/access/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.enrolled).toBe(true);
    // Now enrolled, so a further attempt needs permission.
    expect(me.body.canEnrol).toBe(false);
  });
});

describe('re-enrolment needs an HR grant', () => {
  it('refuses a second enrolment with no grant', async () => {
    const { token } = await seedUser('Enrolled', 'enrolled@companya.com');
    expect((await enrol(token)).status).toBe(200);

    const second = await enrol(token);
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('REVERIFICATION_NOT_AUTHORISED');
  });

  it('an ordinary employee cannot grant access, to themselves or anyone', async () => {
    const { user, token } = await seedUser('Employee', 'emp@companya.com');
    const res = await request(app)
      .post('/api/v1/face/access')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: String(user._id), reason: 'I want to redo it' });
    expect(res.status).toBe(403);
    expect(await FaceAccessGrant.countDocuments()).toBe(0);
  });

  it('HR cannot grant it to their own account either', async () => {
    const { user, token } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    const res = await request(app)
      .post('/api/v1/face/access')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: String(user._id), reason: 'mine' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_GRANT_FORBIDDEN');
  });

  it('requires a reason, so every grant is explainable', async () => {
    const { user } = await seedUser('Employee', 'emp@companya.com');
    const { token: hrToken } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    const res = await request(app)
      .post('/api/v1/face/access')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ userId: String(user._id) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
  });

  it('lets exactly the granted employee re-enrol, once, and audits it', async () => {
    const { user, token } = await seedUser('Employee', 'emp@companya.com');
    const { user: other, token: otherToken } = await seedUser('Other', 'other@companya.com');
    const { token: hrToken } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    await enrol(token);
    await enrol(otherToken);

    const granted = await request(app)
      .post('/api/v1/face/access')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ userId: String(user._id), reason: 'Face check-in keeps failing', hours: 6 });
    expect(granted.status).toBe(201);
    expect(granted.body.status).toBe('active');
    expect(granted.body.userId).toBe(String(user._id));

    // The grant belongs to one account: nobody else gains anything.
    const otherMe = await request(app).get('/api/v1/face/access/me').set('Authorization', `Bearer ${otherToken}`);
    expect(otherMe.body.canEnrol).toBe(false);
    expect(otherMe.body.grant).toBeNull();
    expect((await enrol(otherToken)).status).toBe(403);
    expect(String(await FaceDescriptor.findOne({ userId: other._id }).then((d) => d.descriptor[0]))).toBe('0.1');

    const me = await request(app).get('/api/v1/face/access/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.canEnrol).toBe(true);
    expect(me.body.grant.reason).toBe('Face check-in keeps failing');

    expect((await enrol(token)).status).toBe(200);

    // Spent: the same grant cannot be reused for another replacement.
    const afterUse = await enrol(token);
    expect(afterUse.status).toBe(403);
    expect((await FaceAccessGrant.findById(granted.body.id)).usedAt).not.toBeNull();

    const actions = (await AuditLog.find({ subject: 'Employee' })).map((a) => a.action);
    expect(actions).toContain('Face re-verification access granted');
    expect(actions).toContain('Face re-verification access used');
  });

  it('stops working once revoked or expired', async () => {
    const { user, token } = await seedUser('Employee', 'emp@companya.com');
    const { token: hrToken } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    await enrol(token);

    const granted = await request(app)
      .post('/api/v1/face/access')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ userId: String(user._id), reason: 'wrong face stored' });
    const revoked = await request(app)
      .delete(`/api/v1/face/access/${granted.body.id}`)
      .set('Authorization', `Bearer ${hrToken}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect((await enrol(token)).status).toBe(403);

    // A grant whose window has passed is equally useless.
    await FaceAccessGrant.create({
      userId: user._id, reason: 'expired one', company: COMPANY,
      expiresAt: new Date(Date.now() - 1000),
    });
    const me = await request(app).get('/api/v1/face/access/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.canEnrol).toBe(false);
    expect((await enrol(token)).status).toBe(403);
  });

  it('HR can still enrol on behalf of an employee, as before', async () => {
    const { user, token } = await seedUser('Employee', 'emp@companya.com');
    const { token: hrToken } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    await enrol(token);

    const res = await request(app)
      .post('/api/v1/face/enroll')
      .set('Authorization', `Bearer ${hrToken}`)
      .field('userId', String(user._id))
      .attach('photo', photo, { filename: 'face.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.enrolledFor).toBe('Employee');
  });

  it('shows HR the grant history for one account', async () => {
    const { user } = await seedUser('Employee', 'emp@companya.com');
    const { token: hrToken } = await seedUser('HR Person', 'hr@companya.com', 'HR Manager');
    await request(app).post('/api/v1/face/access').set('Authorization', `Bearer ${hrToken}`)
      .send({ userId: String(user._id), reason: 'first' });
    await request(app).post('/api/v1/face/access').set('Authorization', `Bearer ${hrToken}`)
      .send({ userId: String(user._id), reason: 'second' });

    const list = await request(app)
      .get(`/api/v1/face/access?userId=${user._id}`)
      .set('Authorization', `Bearer ${hrToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    // Re-granting replaces the earlier window rather than stacking two.
    expect(list.body.filter((g) => g.status === 'active')).toHaveLength(1);
  });
});
