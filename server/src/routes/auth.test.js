import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// Real email delivery is out of scope for an automated test — mock the one
// function that would otherwise open a real SMTP connection, so the 2FA
// flow can be exercised end-to-end (including reading the code it "sends")
// without any network dependency.
vi.mock('../lib/mailer.js', () => ({
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Settings = (await import('../models/Settings.js')).default;
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
}, 60000);

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

  it('issues a real session (token + cookie) when 2FA is off', async () => {
    await seedUser();
    await Settings.create({ _id: COMPANY, twoFactor: false });
    const res = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.headers['set-cookie']?.[0]).toMatch(/sepl_refresh=/);
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

  it('withholds the session and emails a code when 2FA is on, then issues a session on correct verification', async () => {
    await seedUser();
    await Settings.create({ _id: COMPANY, twoFactor: true });

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.requiresTwoFactor).toBe(true);
    expect(loginRes.body.accessToken).toBeUndefined();
    expect(loginRes.headers['set-cookie']).toBeUndefined();
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);

    const [, sentOtp] = sendOtpEmail.mock.calls[0];

    const wrongOtpRes = await request(app).post('/api/v1/auth/verify-2fa').send({ email: EMAIL, otp: '000000' });
    expect(wrongOtpRes.status).toBe(400);
    expect(wrongOtpRes.body.error.code).toBe('INVALID_OTP');

    const verifyRes = await request(app).post('/api/v1/auth/verify-2fa').send({ email: EMAIL, otp: sentOtp });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.accessToken).toBeTruthy();
    expect(verifyRes.headers['set-cookie']?.[0]).toMatch(/sepl_refresh=/);
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
