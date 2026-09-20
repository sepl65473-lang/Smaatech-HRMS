import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// Real email delivery is out of scope for an automated test — mock the one
// function that would otherwise open a real SMTP connection, so the
// password-reset flow can be exercised end-to-end (including reading the
// code it "sends") without any network dependency.
vi.mock('../lib/mailer.js', () => ({
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const { sendOtpEmail } = await import('../lib/mailer.js');

const COMPANY = 'TestCo';
const EMAIL = 'auth-test@example.com';
const PASSWORD = 'CorrectPass123';

async function seedUser(overrides = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return User.create({
    name: 'Auth Test User',
    email: EMAIL,
    passwordHash,
    role: 'Employee',
    company: COMPANY,
    active: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  vi.clearAllMocks();
});

describe('POST /auth/login', () => {
  it('rejects an unknown email', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'whatever123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a wrong password', async () => {
    await seedUser();
    const res = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'WrongPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('issues a real session (token + cookie) on a correct password', async () => {
    await seedUser();
    const res = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.headers['set-cookie']?.[0]).toMatch(/sepl_refresh=/);

    // The JWT itself carries name/email now — every route that logs an
    // AuditLog entry off req.auth (see lib/auditLogger.js) gets a real
    // actor name instead of the pre-fix "System" fallback.
    const decoded = jwt.decode(res.body.accessToken);
    expect(decoded.name).toBe('Auth Test User');
    expect(decoded.email).toBe(EMAIL);

    const updatedUser = await User.findOne({ email: EMAIL });
    expect(updatedUser.lastLoginAt).toBeTruthy();
    expect(updatedUser.lastLoginIp).toBeTruthy();

    const signedInLog = await AuditLog.findOne({ action: 'User signed in', 'actor.id': String(updatedUser._id) });
    expect(signedInLog).toBeTruthy();
    expect(signedInLog.actor.name).toBe('Auth Test User');
  });

  it('records a Failed sign-in attempt audit log entry on a wrong password', async () => {
    await seedUser();
    await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'WrongPassword1' });

    const failedLog = await AuditLog.findOne({ action: 'Failed sign-in attempt', subject: EMAIL });
    expect(failedLog).toBeTruthy();
  });

  it('locks the account after 5 wrong passwords and rejects the correct one too', async () => {
    await seedUser();
    await Settings.create({ _id: COMPANY, twoFactor: false });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'WrongPassword1' });
    }
    const res = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('never asks for a second factor, even where a legacy twoFactor: true is still stored', async () => {
    await seedUser();
    // Written past the schema on purpose: production Settings documents still
    // carry the old flag, and it must no longer change anything.
    await Settings.collection.insertOne({ _id: COMPANY, twoFactor: true });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.requiresTwoFactor).toBeUndefined();
    expect(loginRes.body.accessToken).toBeTruthy();
    expect(loginRes.headers['set-cookie']?.[0]).toMatch(/sepl_refresh=/);
    expect(sendOtpEmail).not.toHaveBeenCalled();

    const verifyRes = await request(app).post('/api/v1/auth/verify-2fa').send({ email: EMAIL, otp: '123456' });
    expect(verifyRes.status).toBe(404);
  });
});

describe('session lifecycle after a password sign-in', () => {
  const cookieOf = (res) => res.headers['set-cookie'].find((c) => c.startsWith('sepl_refresh=')).split(';')[0];

  it('restores the session on refresh, serves protected routes, and stops after logout', async () => {
    await seedUser();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    const firstCookie = cookieOf(loginRes);

    // What a browser reload does: no access token in memory, only the cookie.
    const refreshRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', firstCookie);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeTruthy();
    expect(refreshRes.body.requiresTwoFactor).toBeUndefined();
    const rotatedCookie = cookieOf(refreshRes);

    const meRes = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${refreshRes.body.accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(EMAIL);

    // Rotation: the cookie a refresh consumed cannot be replayed.
    const replayRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', firstCookie);
    expect(replayRes.status).toBe(401);

    const logoutRes = await request(app).post('/api/v1/auth/logout').set('Cookie', rotatedCookie);
    expect(logoutRes.status).toBe(200);
    const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', rotatedCookie);
    expect(afterLogout.status).toBe(401);
  });

  it('refuses an expired refresh session', async () => {
    await seedUser();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    const RefreshToken = (await import('../models/RefreshToken.js')).default;
    await RefreshToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieOf(loginRes));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
  });

  it('refuses sign-in and refresh for a deactivated account', async () => {
    const user = await seedUser();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    await User.updateOne({ _id: user._id }, { active: false });

    const refreshRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieOf(loginRes));
    expect(refreshRes.status).toBe(403);
    expect(refreshRes.body.error.code).toBe('ACCOUNT_DISABLED');

    const relogin = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('POST /auth/login-mobile', () => {
  const MOBILE = '+91 98765 43210';

  // An employee record with a phone, and the login linked to it: exactly what
  // Employee Management creates.
  async function seedEmployeeWithMobile(phone = MOBILE) {
    const emp = await Employee.create({
      name: 'Auth Test User', email: EMAIL, phone, company: COMPANY, role: 'Engineer', dept: 'Engineering',
    });
    const user = await seedUser({ employeeId: emp._id });
    return { emp, user };
  }

  it('signs in with the registered mobile number and the SAME password', async () => {
    const { user } = await seedEmployeeWithMobile();
    const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.headers['set-cookie']?.[0]).toMatch(/sepl_refresh=/);

    // The same account, not a parallel one.
    expect(res.body.user.id).toBe(String(user._id));
    const signedIn = await AuditLog.findOne({ action: 'User signed in', subject: EMAIL });
    expect(signedIn).toBeTruthy();
  });

  it('accepts the number however it was typed, and the email login still works', async () => {
    await seedEmployeeWithMobile();
    for (const typed of ['9876543210', '09876543210', '+919876543210', '98765-43210']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: typed, password: PASSWORD });
      expect(res.status).toBe(200);
    }
    const emailRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(emailRes.status).toBe(200);
  });

  it('refuses an unregistered number even with the correct password', async () => {
    await seedEmployeeWithMobile();
    const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: '9000000000', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.accessToken).toBeUndefined();
  });

  it('refuses the wrong password on a registered number', async () => {
    await seedEmployeeWithMobile();
    const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: 'WrongPassword1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses an employee whose record has no login account', async () => {
    await Employee.create({ name: 'No Login', email: 'no-login@example.com', phone: MOBILE, company: COMPANY, role: 'Engineer', dept: 'Engineering' });
    const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses a number two employees share, since it names no single account', async () => {
    await seedEmployeeWithMobile();
    await Employee.create({ name: 'Same Number', email: 'same@example.com', phone: '09876543210', company: COMPANY, role: 'Engineer', dept: 'Engineering' });
    const res = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses a deactivated account, and counts wrong tries toward the same lockout', async () => {
    const { user } = await seedEmployeeWithMobile();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: 'WrongPassword1' });
    }
    // The lockout is the account's, so the EMAIL route is locked too.
    const emailRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(emailRes.status).toBe(423);

    await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, lockedUntil: null, active: false });
    const disabled = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: PASSWORD });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('works with the new password after an email password reset, and so does email', async () => {
    await seedEmployeeWithMobile();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: EMAIL });
    const [, sentOtp] = sendOtpEmail.mock.calls[0];
    const reset = await request(app).post('/api/v1/auth/reset-password').send({ email: EMAIL, otp: sentOtp, newPassword: 'NewPass456' });
    expect(reset.status).toBe(200);

    const byMobile = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: 'NewPass456' });
    expect(byMobile.status).toBe(200);
    const byEmail = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'NewPass456' });
    expect(byEmail.status).toBe(200);

    const oldPassword = await request(app).post('/api/v1/auth/login-mobile').send({ mobile: MOBILE, password: PASSWORD });
    expect(oldPassword.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NewPass456' });
    expect(res.status).toBe(401);
  });

  it('rejects the wrong current password and accepts a correct change', async () => {
    await seedUser();
    await Settings.create({ _id: COMPANY, twoFactor: false });
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    const token = loginRes.body.accessToken;

    const wrongRes = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'NotTheRealPassword', newPassword: 'NewPass456' });
    expect(wrongRes.status).toBe(400);
    expect(wrongRes.body.error.code).toBe('INVALID_PASSWORD');

    const okRes = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'NewPass456' });
    expect(okRes.status).toBe(200);

    const oldLoginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(oldLoginRes.status).toBe(401);
    const newLoginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'NewPass456' });
    expect(newLoginRes.status).toBe(200);
  });
});

describe('POST /auth/forgot-password + /auth/reset-password', () => {
  it('does not reveal whether the email is registered', async () => {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('locks the account after 5 wrong reset codes, same as a wrong password', async () => {
    await seedUser();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: EMAIL });
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/v1/auth/reset-password').send({ email: EMAIL, otp: '000000', newPassword: 'NewPass456' });
      expect(res.status).toBe(400);
    }

    const lockedRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(lockedRes.status).toBe(423);
    expect(lockedRes.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('accepts the correct code and the new password works to sign in', async () => {
    await seedUser();
    await Settings.create({ _id: COMPANY, twoFactor: false });
    await request(app).post('/api/v1/auth/forgot-password').send({ email: EMAIL });
    const [, sentOtp] = sendOtpEmail.mock.calls[0];

    const wrongRes = await request(app).post('/api/v1/auth/reset-password').send({ email: EMAIL, otp: '000000', newPassword: 'NewPass456' });
    expect(wrongRes.status).toBe(400);

    const okRes = await request(app).post('/api/v1/auth/reset-password').send({ email: EMAIL, otp: sentOtp, newPassword: 'NewPass456' });
    expect(okRes.status).toBe(200);

    const newLoginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: 'NewPass456' });
    expect(newLoginRes.status).toBe(200);
  });
});
