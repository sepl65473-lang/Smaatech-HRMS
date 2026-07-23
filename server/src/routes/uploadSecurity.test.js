// Regression tests for a batch of file-upload security fixes: mass-assignment
// on documents/attendance PATCH routes (a client could previously set fileRef/
// checkInPhotoRef/company directly, bypassing the safe server-generated refs
// and reassigning tenant ownership), and multer fileFilter rejecting
// unexpected file types.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const Document = (await import('../models/Document.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'UploadCo';

async function ensureHrManagerRole() {
  const exists = await Role.findOne({ name: 'HR Manager' });
  if (!exists) {
    await Role.create({
      name: 'HR Manager',
      description: 'Manage employee directory',
      allowedPaths: ['/documents', '/attendance'],
      allowedActions: ['manageEmployees', 'manageAttendance'],
    });
  }
}

async function seedHrToken(company = COMPANY) {
  await Settings.create({ _id: company, twoFactor: false });
  await ensureHrManagerRole();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `hr-${company.toLowerCase()}@example.com`;
  await User.create({ name: `HR ${company}`, email, passwordHash, role: 'HR Manager', company, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

beforeAll(async () => {
  await startTestDB();
}, 60000);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

describe('documents PATCH mass-assignment protection', () => {
  it('ignores a client-supplied fileRef/company and only applies whitelisted fields', async () => {
    const token = await seedHrToken();
    const doc = await Document.create({
      title: 'Original', owner: 'System', folder: 'people', fileRef: 'documents/real-file.pdf', company: COMPANY,
    });

    const res = await request(app)
      .patch(`/api/v1/documents/${doc.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated Title', fileRef: '../../etc/passwd', company: 'SomeoneElseCo' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Title');
    // fileRef and company must be untouched by the request body.
    expect(res.body.fileRef).toBe('documents/real-file.pdf');
    expect(res.body.company).toBe(COMPANY);

    const stored = await Document.findById(doc.id);
    expect(stored.fileRef).toBe('documents/real-file.pdf');
    expect(stored.company).toBe(COMPANY);
  });

  it('rejects an unsupported file type on upload', async () => {
    const token = await seedHrToken();
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Malicious')
      .field('owner', 'System')
      .field('folder', 'people')
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE');
  });
});

describe('attendance PATCH mass-assignment protection', () => {
  it('ignores a client-supplied checkInPhotoRef/company and only applies whitelisted fields', async () => {
    const token = await seedHrToken();
    const emp = await Employee.create({ name: 'Roster Emp', role: 'Engineer', dept: 'Engineering', loc: 'Remote', company: COMPANY });
    const row = await Attendance.create({ empId: emp._id, date: '2026-07-20', company: COMPANY, checkInPhotoRef: null });

    const res = await request(app)
      .patch(`/api/v1/attendance/${row.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'present', checkInPhotoRef: 'attendance/someone-else/x.jpg', company: 'SomeoneElseCo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('present');
    expect(res.body.checkInPhotoRef).toBeNull();
    expect(res.body.company).toBe(COMPANY);

    const stored = await Attendance.findById(row.id);
    expect(stored.checkInPhotoRef).toBeNull();
    expect(stored.company).toBe(COMPANY);
  });
});
