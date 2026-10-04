// Face sign-in checks a single still photo and has no liveness challenge. When
// the company requires liveness it must not remain as a way around that check.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import jpeg from 'jpeg-js';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const ENROLLED = Array(128).fill(0.1);
vi.mock('../lib/faceEngine.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // The server "sees" the enrolled face: the strongest case for acceptance.
  extractDescriptor: vi.fn(async () => ({ descriptor: Array(128).fill(0.1) })),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const FaceDescriptor = (await import('../models/FaceDescriptor.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;

const COMPANY = 'Smaatech';
const EMAIL = 'face@example.com';
const PASSWORD = 'CorrectPass123';

function photo() {
  const size = 160;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) { data[i * 4] = (i * 7) % 256; data[i * 4 + 1] = (i * 13) % 256; data[i * 4 + 2] = (i * 3) % 256; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: size, height: size }, 80).data;
}

const faceLogin = () => request(app).post('/api/v1/auth/face-login')
  .field('email', EMAIL)
  .attach('photo', photo(), { filename: 'f.jpg', contentType: 'image/jpeg' });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });

beforeEach(async () => {
  await clearTestDB();
  const user = await User.create({ name: 'Face User', email: EMAIL, passwordHash: await bcrypt.hash(PASSWORD, 10), role: 'Employee', company: COMPANY, active: true });
  await FaceDescriptor.create({ userId: user._id, descriptor: ENROLLED });
});

describe('face sign-in and the liveness requirement', () => {
  it('is refused when liveness is required, even for a photo that matches the enrolled face', async () => {
    await Settings.create({ _id: COMPANY, livenessRequired: true });
    const res = await faceLogin();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('LIVENESS_REQUIRED');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await AuditLog.countDocuments({ action: 'Failed face sign-in attempt', subject: EMAIL })).toBe(1);
  });

  it('leaves password sign-in working when liveness is required', async () => {
    await Settings.create({ _id: COMPANY, livenessRequired: true });
    const res = await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('behaves exactly as before when liveness is not required', async () => {
    await Settings.create({ _id: COMPANY, livenessRequired: false });
    const res = await faceLogin();
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });
});
