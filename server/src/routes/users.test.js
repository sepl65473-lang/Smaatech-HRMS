import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const EmailLog = (await import('../models/EmailLog.js')).default;

const PASSWORD = 'CorrectPass123';

async function seedDirector() {
  await Settings.create({ _id: 'Smaatech', twoFactor: false });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return User.create({
    name: 'HR Director User',
    email: 'director@smaatech.co',
    passwordHash,
    role: 'HR Director',
    company: 'Smaatech',
    status: 'Active',
    mustChangePassword: false,
  });
}

async function loginAs(email) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD });
  return res.body.accessToken;
}

describe('User Account Creation, Status & Welcome Email Tests', () => {
  beforeAll(async () => { await startTestDB(); });
  afterAll(async () => { await stopTestDB(); });
  beforeEach(async () => { await clearTestDB(); });

  it('creates user account with status Active, mustChangePassword true, and logs to EmailLog', async () => {
    await seedDirector();
    const token = await loginAs('director@smaatech.co');

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'New Employee User',
        email: 'new.emp@smaatech.co',
        password: 'TempPassword123',
        role: 'Employee',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Employee User');
    expect(res.body.status).toBe('Active');
    expect(res.body.mustChangePassword).toBe(true);
    expect(res.body.emailStatus).toBe('SENT');

    const logs = await EmailLog.find({ email: 'new.emp@smaatech.co' });
    expect(logs.length).toBe(1);
    expect(logs[0].emailType).toBe('WELCOME');
    expect(logs[0].status).toBe('SENT');
  });

  it('resends welcome email for an existing user via POST /users/:id/resend-welcome', async () => {
    const director = await seedDirector();
    const token = await loginAs('director@smaatech.co');

    const newUser = await User.create({
      name: 'Target User',
      email: 'target@smaatech.co',
      passwordHash: await bcrypt.hash('OldPass123', 10),
      role: 'Employee',
      company: 'Smaatech',
      status: 'Active',
      mustChangePassword: false,
    });

    const res = await request(app)
      .post(`/api/v1/users/${newUser._id}/resend-welcome`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailStatus).toBe('SENT');
    expect(res.body.tempPassword).toBeDefined();

    const updatedUser = await User.findById(newUser._id);
    expect(updatedUser.mustChangePassword).toBe(true);

    const logs = await EmailLog.find({ email: 'target@smaatech.co' });
    expect(logs.length).toBe(1);
    expect(logs[0].emailType).toBe('WELCOME');
  });
});
