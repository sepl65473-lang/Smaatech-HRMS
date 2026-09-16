// FRONTEND ↔ BACKEND CONTRACT TESTS.
//
// Every backend test in this suite calls the API the way a *test* would. None
// of them called it the way the SHIPPED CLIENT does — and that gap hid several
// regressions that a purely backend audit cannot see.
//
// These tests replay the exact request shapes in `client/src/data/store.js`
// and `client/src/context/HRMSContext.jsx`, including the bits that make them
// break: `loadAll()` using Promise.all with no per-call catch, `decline(id)`
// sending no body at all, and the post-approval follow-up writes the context
// fires off on the caller's behalf.
//
// If you change a request/response contract on the server, a test here should
// fail before a user finds it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => ({ sent: true })),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Leave = (await import('../models/Leave.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'Smaatech';
const MON = '2026-08-03';
const TUE = '2026-08-04';

async function ensureRoles() {
  const defs = {
    'HR Director': ['manageEmployees', 'manageUsers', 'manageRoles', 'manageSettings', 'managePayroll', 'manageLeave', 'manageAttendance', 'manageRecruitment'],
    'HR Manager': ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment'],
    'Finance Lead': ['managePayroll', 'manageDocuments'],
    Employee: [],
  };
  for (const [name, allowedActions] of Object.entries(defs)) {
    if (!(await Role.findOne({ name }))) await Role.create({ name, allowedActions });
  }
}

async function seedUser(role, key, employeeId = null) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key}@example.com`;
  await User.create({ name: key, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

let ctx;

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({
    _id: COMPANY,
    twoFactor: false,
    gatewaySmtpPass: 'real-smtp-password',
    gatewayTwilioToken: 'real-twilio-token',
    gatewaySmtpHost: 'smtp.example.com',
  });
  await ensureRoles();

  const manager = await Employee.create({
    name: 'Manager', role: 'Engineering Manager', dept: 'Engineering', loc: 'Bengaluru',
    email: 'manager.emp@example.com', status: 'active', company: COMPANY,
  });
  const worker = await Employee.create({
    name: 'Worker', role: 'Engineer', dept: 'Engineering', loc: 'Bengaluru',
    email: 'worker.emp@example.com', status: 'active', company: COMPANY, managerId: manager._id,
  });
  ctx = {
    manager,
    worker,
    tokens: {
      employee: await seedUser('Employee', 'worker', worker._id),
      manager: await seedUser('Employee', 'manager', manager._id),
      hrManager: await seedUser('HR Manager', 'hrmgr'),
      hrDirector: await seedUser('HR Director', 'director'),
      financeLead: await seedUser('Finance Lead', 'finance'),
    },
  };
});

const get = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`);

// ── The exact collection set client/src/data/store.js loadAll() fetches ──────
// Order and catch-behaviour mirror the real function: only the last five have
// a `.catch(() => [])`, so a rejection from ANY of the others fails the whole
// Promise.all and the app never finishes loading.
const LOAD_ALL_UNGUARDED = [
  '/api/v1/employees',
  '/api/v1/attendance',
  '/api/v1/leaves',
  '/api/v1/payroll',
  '/api/v1/celebrations',
  '/api/v1/holidays',
  '/api/v1/recruitment',
  '/api/v1/reviews',
  '/api/v1/expenses',
  '/api/v1/assets',
  '/api/v1/jobs',
  '/api/v1/settings',
  '/api/v1/roles',
  '/api/v1/master-data/master-categories',
  '/api/v1/master-data/master-values',
];

describe('app bootstrap — loadAll() must succeed for EVERY role', () => {
  // The regression this catches: `recruitmentApi.list()` has no .catch() in
  // loadAll(), so gating GET /recruitment to HR made Promise.all reject for
  // Employees and Finance Leads — the app failed to load at all on login.
  for (const role of ['employee', 'manager', 'hrManager', 'hrDirector', 'financeLead']) {
    it(`${role} can fetch every unguarded loadAll() collection`, async () => {
      const failures = [];
      for (const path of LOAD_ALL_UNGUARDED) {
        // eslint-disable-next-line no-await-in-loop
        const res = await get(path, ctx.tokens[role]);
        if (res.status >= 400) failures.push(`${path} -> ${res.status} ${res.body?.error?.code || ''}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('leave decline — the client sends NO body', () => {
  async function fileLeave() {
    const res = await request(app)
      .post('/api/v1/leaves')
      .set('Authorization', `Bearer ${ctx.tokens.employee}`)
      .send({ empId: String(ctx.worker._id), type: 'casual', start: MON, end: TUE, reason: 'Trip' });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('leavesApi.decline(id) with no body must not fail the request', async () => {
    // client/src/data/store.js: decline: (id) => apiFetch(`/leaves/${id}/decline`, { method: 'POST' })
    // No body is sent, so a server-side mandatory `note` broke decline entirely
    // in the UI — every rejection surfaced as an error toast.
    const id = await fileLeave();
    const res = await request(app)
      .post(`/api/v1/leaves/${id}/decline`)
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
  });

  it('still records a reason when the client does supply one', async () => {
    const id = await fileLeave();
    const res = await request(app)
      .post(`/api/v1/leaves/${id}/decline`)
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send({ note: 'Release week' });
    expect(res.body.declineReason).toBe('Release week');
  });
});

describe('attendance correction reject — the client sends NO body', () => {
  it('reject(id) with no body must not fail the request', async () => {
    // client/src/data/store.js:
    //   reject: (id) => apiFetch(`/attendance-corrections/${id}/reject`, { method: 'POST' })
    const filed = await request(app)
      .post('/api/v1/attendance-corrections')
      .set('Authorization', `Bearer ${ctx.tokens.employee}`)
      .send({
        employeeId: String(ctx.worker._id), date: MON,
        requestedCheckIn: '09:00', requestedCheckOut: '18:00', reason: 'Badge failed',
      });
    expect(filed.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/attendance-corrections/${filed.body.id}/reject`)
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
  });
});

describe('reporting-manager leave approval — the follow-up writes the context makes', () => {
  it('a manager approving their report can also run the on-leave attendance sync', async () => {
    // HRMSContext.setLeaveStatus() fires employeesApi.update(empId, { status:
    // 'on-leave' }) straight after a successful approval. If the approver is a
    // Reporting Manager (a plain Employee role), that PATCH must not 403 —
    // otherwise approval "succeeds" and then throws an unhandled rejection.
    await Settings.findByIdAndUpdate(COMPANY, { approvalWorkflows: { leave: ['Reporting Manager'] } });

    const filed = await request(app)
      .post('/api/v1/leaves')
      .set('Authorization', `Bearer ${ctx.tokens.employee}`)
      .send({ empId: String(ctx.worker._id), type: 'casual', start: MON, end: TUE });
    expect(filed.status).toBe(201);

    const approved = await request(app)
      .post(`/api/v1/leaves/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send();
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const followUp = await request(app)
      .patch(`/api/v1/employees/${ctx.worker._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ status: 'on-leave' });
    expect(followUp.status).toBe(200);
    expect((await Employee.findById(ctx.worker._id)).status).toBe('on-leave');
  });

  it('a manager still cannot change a report salary or role', async () => {
    // The narrow on-leave allowance must not become a general write grant.
    await request(app)
      .patch(`/api/v1/employees/${ctx.worker._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ salary: 9999999, role: 'HR Director' });

    const stored = await Employee.findById(ctx.worker._id);
    expect(stored.salary).not.toBe(9999999);
    expect(stored.role).not.toBe('HR Director');
  });

  it('a manager cannot touch someone outside their team', async () => {
    const outsider = await Employee.create({ name: 'Outsider', dept: 'Sales', company: COMPANY });
    const res = await request(app)
      .patch(`/api/v1/employees/${outsider._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ status: 'on-leave' });
    expect(res.status).toBe(403);
  });
});

describe('settings gateway credentials — blank must not wipe a stored secret', () => {
  it('GET does not return the secret values', async () => {
    const res = await get('/api/v1/settings', ctx.tokens.hrDirector);
    expect(JSON.stringify(res.body)).not.toContain('real-smtp-password');
    expect(res.body.secretsConfigured.gatewaySmtpPass).toBe(true);
  });

  it('PATCHing back the blanks the UI now renders LEAVES THE STORED SECRETS INTACT', async () => {
    // Settings.jsx seeds its inputs from settings.gatewaySmtpPass etc. Those
    // are redacted now, so the inputs render empty; "Save Credentials" then
    // PATCHes all six fields back as ''. Without this rule that silently
    // destroys the company's live SMTP password and Twilio token, and email
    // delivery stops.
    const res = await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', `Bearer ${ctx.tokens.hrDirector}`)
      .send({
        gatewayTwilioSid: '',
        gatewayTwilioToken: '',
        gatewayTwilioFrom: '',
        gatewaySmtpHost: 'smtp.newhost.com',
        gatewaySmtpUser: '',
        gatewaySmtpPass: '',
      });
    expect(res.status).toBe(200);

    const stored = await Settings.findById(COMPANY);
    expect(stored.gatewaySmtpPass).toBe('real-smtp-password');
    expect(stored.gatewayTwilioToken).toBe('real-twilio-token');
    // A non-empty value still updates normally.
    expect(stored.gatewaySmtpHost).toBe('smtp.newhost.com');
  });

  it('a real new value does replace the old secret', async () => {
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', `Bearer ${ctx.tokens.hrDirector}`)
      .send({ gatewaySmtpPass: 'rotated-password' });

    expect((await Settings.findById(COMPANY)).gatewaySmtpPass).toBe('rotated-password');
  });
});

describe('document download — the client asks for a BLOB', () => {
  it('streams bytes rather than a JSON envelope on the default local driver', async () => {
    // client/src/data/store.js: download: (id) => apiFetchBlob(...)
    // It runs responseType:'blob' and hands the result to URL.createObjectURL.
    // A JSON body here means the user downloads a file containing
    // {"url":"https://..."} instead of their document.
    const created = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${ctx.tokens.hrDirector}`)
      .field('title', 'Offer Letter')
      .field('visibility', 'all')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf body'), { filename: 'offer.pdf', contentType: 'application/pdf' });
    expect(created.status).toBe(201);

    const res = await get(`/api/v1/documents/${created.body.id}/download`, ctx.tokens.hrDirector);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.toString()).toContain('fake pdf body');
  });

  it('only returns a signed-URL envelope when the caller opts in', async () => {
    const created = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${ctx.tokens.hrDirector}`)
      .field('title', 'Policy')
      .attach('file', Buffer.from('%PDF-1.4 policy'), { filename: 'p.pdf', contentType: 'application/pdf' });

    // On the local driver there is no signed URL to give, so it must still
    // stream rather than 500 or hand back a null url.
    const res = await get(`/api/v1/documents/${created.body.id}/download?mode=url`, ctx.tokens.hrDirector);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

describe('F&F payout — the client sends NO body', () => {
  it('payFnF(id) surfaces outstanding clearances as an actionable error, not a silent failure', async () => {
    const { default: Resignation } = await import('../models/Resignation.js');
    const filed = await Resignation.create({
      employeeId: ctx.worker._id,
      employeeName: 'Worker',
      resignationDate: '2026-07-01',
      requestedLastWorkingDay: '2026-08-01',
      reason: 'Relocating',
      clearances: [{ dept: 'IT', status: 'Pending' }, { dept: 'Finance', status: 'Approved' }],
      company: COMPANY,
    });
    await request(app).post(`/api/v1/resignations/${filed._id}/fnf`)
      .set('Authorization', `Bearer ${ctx.tokens.financeLead}`).send({ monthlySalary: 50000 });

    // client/src/data/store.js: payFnF: (id) => apiFetch(..., { method: 'POST' })
    const res = await request(app)
      .post(`/api/v1/resignations/${filed._id}/fnf/pay`)
      .set('Authorization', `Bearer ${ctx.tokens.financeLead}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLEARANCES_PENDING');
    // The message must name what is outstanding so the UI can tell the user.
    expect(res.body.error.outstanding).toEqual(['IT']);
  });
});

describe('single-record GETs the client calls with restResource.get()', () => {
  it('employees.get on a missing id returns a structured error the client can read', async () => {
    const res = await get('/api/v1/employees/000000000000000000000000', ctx.tokens.hrDirector);
    expect(res.status).toBe(404);
    // apiClient maps error.response.data.error.code into an ApiError.
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBeTruthy();
  });

  it('every error response carries the {error:{code,message}} shape apiClient expects', async () => {
    const cases = [
      get('/api/v1/employees/not-an-id', ctx.tokens.hrDirector),
      get('/api/v1/payroll/000000000000000000000000', ctx.tokens.hrDirector),
      get('/api/v1/leaves/000000000000000000000000', ctx.tokens.hrDirector),
      get('/api/v1/attendance/000000000000000000000000', ctx.tokens.hrDirector),
      get('/api/v1/users', ctx.tokens.employee),
      request(app).get('/api/v1/employees'),
    ];
    for (const p of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await p;
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error, `missing error envelope for ${res.req.path}`).toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');
    }
  });
});

describe('redaction must not break the UI shape', () => {
  it('a redacted employee row still carries every field the directory renders', async () => {
    const res = await get('/api/v1/employees', ctx.tokens.employee);
    const row = res.body.find((e) => e.id === String(ctx.manager._id));
    // Pages/Employees.jsx renders these; they must survive redaction.
    for (const field of ['id', 'name', 'role', 'dept', 'loc', 'status', 'email']) {
      expect(row, `redacted row lost "${field}"`).toHaveProperty(field);
    }
    // ...while the confidential ones are gone.
    expect(row.salary).toBeUndefined();
    expect(row.bankAccount).toBeUndefined();
  });

  it('the employee own-record path is never redacted', async () => {
    await Employee.findByIdAndUpdate(ctx.worker._id, { salary: 123456 });
    const res = await get('/api/v1/employees', ctx.tokens.employee);
    const own = res.body.find((e) => e.id === String(ctx.worker._id));
    expect(own.salary).toBe(123456);
  });
});

describe('attendance self check-in — the client sends field name "photo"', () => {
  it('accepts the single-photo multipart shape the client actually sends', async () => {
    const jpeg = (await import('jpeg-js')).default;
    const { default: Attendance } = await import('../models/Attendance.js');
    const { default: FaceDescriptor } = await import('../models/FaceDescriptor.js');
    const { todayISO } = await import('../lib/dateUtils.js');

    const user = await User.findOne({ email: 'worker@example.com' });
    await FaceDescriptor.create({ userId: user._id, descriptor: Array(128).fill(0.1) });
    const row = await Attendance.create({
      empId: ctx.worker._id, name: 'Worker', date: todayISO(), company: COMPANY,
    });

    const width = 160; const height = 160;
    const data = Buffer.alloc(width * height * 4, 120);
    const buf = jpeg.encode({ data, width, height }, 80).data;

    const res = await request(app)
      .post(`/api/v1/attendance/${row.id}/check-in`)
      .set('Authorization', `Bearer ${ctx.tokens.employee}`)
      .field('deviceId', 'browser-abc')
      .attach('photo', buf, { filename: 'selfie.jpg', contentType: 'image/jpeg' });

    // The face model will reject a flat grey frame (NO_FACE) — that is fine.
    // What must NOT happen is a 500, or a "no photo received" error, which is
    // what a multer field-name mismatch would produce.
    expect(res.status).not.toBe(500);
    expect(res.body?.error?.code).not.toBe('NO_PHOTO');
  });
});
