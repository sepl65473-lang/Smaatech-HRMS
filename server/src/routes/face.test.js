import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';

async function seedUser(name, email, role = 'Employee', company = 'CompanyA') {
  await Settings.findOneAndUpdate({ _id: company }, { twoFactor: false }, { upsert: true });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ name, email, passwordHash, role, company, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { user, token: login.body.accessToken };
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

describe('Face Biometric Security & Revocation API', () => {
  it('checks face status and enforces authorization', async () => {
    const { user: userA, token: tokenA } = await seedUser('User A', 'usera@companya.com', 'Employee');
    const { user: userB, token: tokenB } = await seedUser('User B', 'userb@companya.com', 'Employee');

    // Initially not enrolled
    const statusA = await request(app)
      .get(`/api/v1/face/status/${userA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(statusA.status).toBe(200);
    expect(statusA.body.enrolled).toBe(false);

    // User B cannot check User A's face status
    const unauthorizedStatus = await request(app)
      .get(`/api/v1/face/status/${userA._id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(unauthorizedStatus.status).toBe(403);

    // Enroll mock descriptor directly for User A
    await FaceDescriptor.create({
      userId: userA._id,
      descriptor: Array(128).fill(0.1),
    });

    const statusEnrolled = await request(app)
      .get(`/api/v1/face/status/${userA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(statusEnrolled.status).toBe(200);
    expect(statusEnrolled.body.enrolled).toBe(true);
  });

  it('revokes biometric template and logs audit event', async () => {
    const { user: userA, token: tokenA } = await seedUser('User A', 'usera@companya.com', 'Employee');
    const { token: tokenB } = await seedUser('User B', 'userb@companya.com', 'Employee');

    // Seed FaceDescriptor
    await FaceDescriptor.create({
      userId: userA._id,
      descriptor: Array(128).fill(0.2),
    });

    // User B cannot delete User A's biometric template
    const forbiddenDelete = await request(app)
      .delete(`/api/v1/face/${userA._id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(forbiddenDelete.status).toBe(403);

    // User A revokes own biometric template
    const deleteRes = await request(app)
      .delete(`/api/v1/face/${userA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // Verify template is deleted
    const doc = await FaceDescriptor.findOne({ userId: userA._id });
    expect(doc).toBeNull();

    // Verify audit log entry
    const auditLogs = await AuditLog.find({ action: 'Biometric face template revoked' });
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].subject).toBe('User A');
  });

  it('rejects POST /enroll without photo', async () => {
    const { token: tokenA } = await seedUser('User A', 'usera@companya.com', 'Employee');
    const res = await request(app)
      .post('/api/v1/face/enroll')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PHOTO');
  });
});
