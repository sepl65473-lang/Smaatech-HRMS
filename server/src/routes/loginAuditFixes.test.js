// Regressions from the login audit: credential hashes in the audit trail, a
// lockout that outlived an admin password reset, sessions that survived an OTP
// reset, and a welcome email skipped for a re-created login.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const EmailLog = (await import('../models/EmailLog.js')).default;
const RefreshToken = (await import('../models/RefreshToken.js')).default;
const { sendWelcomeEmail } = await import('../lib/mailer.js');

const COMPANY = 'AuditFixCo';
const ADMIN = { email: 'director@auditfixco.example.com', password: 'DirectorPass123' };
const STAFF = { email: 'staff@auditfixco.example.com', password: 'StaffPass123' };

async function seed() {
  await User.create({
    name: 'Director', email: ADMIN.email, passwordHash: await bcrypt.hash(ADMIN.password, 10),
    role: 'HR Director', company: COMPANY,
  });
  const staff = await User.create({
    name: 'Staff', email: STAFF.email, passwordHash: await bcrypt.hash(STAFF.password, 10),
    role: 'Employee', company: COMPANY,
  });
  const login = await request(app).post('/api/v1/auth/login').send(ADMIN);
  return { staff, adminToken: login.body.accessToken };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('an admin password reset', () => {
  it('never writes a credential hash to the audit trail', async () => {
    const { staff, adminToken } = await seed();
    const res = await request(app).patch(`/api/v1/users/${staff._id}`).set(as(adminToken)).send({ password: 'ResetPass456' });
    expect(res.status).toBe(200);

    // Creating and removing a login log the whole User document too.
    const created = await request(app).post('/api/v1/users').set(as(adminToken))
      .send({ name: 'Temp Hire', email: 'temp.hire@auditfixco.example.com', password: 'TempHire123', role: 'Employee' });
    expect(created.status).toBe(201);
    const removed = await request(app).delete(`/api/v1/users/${created.body.id}`).set(as(adminToken));
    expect(removed.status).toBe(200);

    const rows = await AuditLog.find({}).lean();
    for (const action of ['Login updated', 'Login created', 'Login removed']) {
      expect(rows.some((r) => r.action === action), action).toBe(true);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('passwordHash');
    expect(dump).not.toContain('$2a$');
    expect(dump).not.toContain('otpHash');
  });

  it('clears an existing lockout so the new password works immediately', async () => {
    const { staff, adminToken } = await seed();
    await User.updateOne({ _id: staff._id }, { failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) });

    await request(app).patch(`/api/v1/users/${staff._id}`).set(as(adminToken)).send({ password: 'ResetPass456' });

    const login = await request(app).post('/api/v1/auth/login').send({ email: STAFF.email, password: 'ResetPass456' });
    expect(login.status).toBe(200);
  });
});

describe('a password reset by emailed code', () => {
  it('ends every session opened with the old password', async () => {
    const { staff } = await seed();
    const old = await request(app).post('/api/v1/auth/login').send(STAFF);
    expect(old.status).toBe(200);

    await User.updateOne({ _id: staff._id }, { otpHash: await bcrypt.hash('123456', 10), otpExpiresAt: new Date(Date.now() + 60000) });
    const reset = await request(app).post('/api/v1/auth/reset-password')
      .send({ email: STAFF.email, otp: '123456', newPassword: 'BrandNew789' });
    expect(reset.status).toBe(200);

    expect(await RefreshToken.countDocuments({ userId: staff._id, revokedAt: null })).toBe(0);
    const stale = await request(app).get('/api/v1/auth/me').set(as(old.body.accessToken));
    expect(stale.status).toBe(401);

    const fresh = await request(app).post('/api/v1/auth/login').send({ email: STAFF.email, password: 'BrandNew789' });
    expect(fresh.status).toBe(200);
  });
});

describe('the welcome email', () => {
  const base = { toEmail: 'rehire@auditfixco.example.com', userName: 'Re Hire', role: 'Employee', company: COMPANY };
  const newUser = () => User.create({ name: 'Re Hire', email: base.toEmail, passwordHash: 'x', role: 'Employee', company: COMPANY });

  it('is sent again for a login re-created with the same address', async () => {
    const first = await newUser();
    const a = await sendWelcomeEmail({ ...base, tempPassword: 'FirstTemp123', userId: first._id });
    await User.deleteOne({ _id: first._id });
    const second = await newUser();
    const b = await sendWelcomeEmail({ ...base, tempPassword: 'SecondTemp456', userId: second._id });

    expect(a.idempotent).toBeUndefined();
    expect(b.idempotent).toBeUndefined();
    expect(await EmailLog.countDocuments({ email: base.toEmail, status: 'SENT' })).toBe(2);
  });

  it('is still not duplicated for the same account', async () => {
    const user = await newUser();
    await sendWelcomeEmail({ ...base, tempPassword: 'FirstTemp123', userId: user._id });
    const again = await sendWelcomeEmail({ ...base, tempPassword: 'FirstTemp123', userId: user._id });

    expect(again.idempotent).toBe(true);
    expect(await EmailLog.countDocuments({ email: base.toEmail })).toBe(1);
  });
});
