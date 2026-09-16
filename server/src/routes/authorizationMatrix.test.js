// BACKEND authorization matrix.
//
// Every assertion here targets the server directly with a real token, because
// a frontend permission check is a UI convenience, not a control. The cases
// are grouped by the class of flaw they prevent: PII/salary disclosure, IDOR
// across employees, cross-tenant access, and privilege escalation.
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
const Payroll = (await import('../models/Payroll.js')).default;
const Role = (await import('../models/Role.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'MatrixCo';
const OTHER_COMPANY = 'RivalCo';

const SENSITIVE = ['salary', 'bankAccount', 'ifsc', 'pan', 'uan', 'esiNumber', 'dob', 'personalEmail', 'emergencyContact', 'family'];

async function ensureRoles() {
  const defs = {
    'HR Director': ['manageEmployees', 'manageUsers', 'manageRoles', 'manageSettings', 'managePayroll', 'manageLeave', 'manageAttendance'],
    'HR Manager': ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment'],
    'Finance Lead': ['managePayroll', 'manageDocuments'],
    Employee: [],
  };
  for (const [name, allowedActions] of Object.entries(defs)) {
    if (!(await Role.findOne({ name }))) await Role.create({ name, allowedActions });
  }
}

async function seedUser(role, key, { employeeId = null, company = COMPANY } = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${key}@example.com`;
  await User.create({ name: key, email, passwordHash, role, company, active: true, employeeId });
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
    gatewaySmtpPass: 'super-secret-smtp-password',
    gatewayTwilioToken: 'twilio-auth-token-value',
    gatewaySendgridKey: 'SG.real-sendgrid-key',
    biometricDeviceApiKey: 'device-key-value',
  });
  await Settings.create({ _id: OTHER_COMPANY, twoFactor: false });
  await ensureRoles();

  const manager = await Employee.create({ name: 'Manager', dept: 'Engineering', company: COMPANY, salary: 200000 });
  const alice = await Employee.create({
    name: 'Alice', role: 'Engineer', loc: 'Bengaluru', status: 'active',
    dept: 'Engineering', company: COMPANY, managerId: manager._id,
    salary: 150000, basic: 75000, bankAccount: '1234567890', ifsc: 'HDFC0001234',
    pan: 'ABCDE1234F', uan: '100200300400', esiNumber: '3100123456', dob: '1992-04-11',
    personalEmail: 'alice.personal@example.com', phone: '+91 90000 00001',
    emergencyContact: { name: 'Bob', relation: 'Spouse', phone: '+91 90000 00002' },
  });
  const bob = await Employee.create({ name: 'Bob', dept: 'Sales', company: COMPANY, salary: 120000, bankAccount: '9999999999' });
  const rival = await Employee.create({ name: 'Rival Person', dept: 'Engineering', company: OTHER_COMPANY, salary: 999999 });

  ctx = {
    manager, alice, bob, rival,
    tokens: {
      alice: await seedUser('Employee', 'alice', { employeeId: alice._id }),
      bob: await seedUser('Employee', 'bob', { employeeId: bob._id }),
      manager: await seedUser('Employee', 'manager', { employeeId: manager._id }),
      hrManager: await seedUser('HR Manager', 'hrmgr'),
      hrDirector: await seedUser('HR Director', 'hrdir'),
      financeLead: await seedUser('Finance Lead', 'finance'),
      rivalDirector: await seedUser('HR Director', 'rivaldir', { company: OTHER_COMPANY }),
    },
  };
});

const get = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`);

describe('salary and PII disclosure on the employee directory', () => {
  it('HIDES salary, bank and statutory identity from a peer employee', async () => {
    // GET /employees had no role gate at all: every authenticated account,
    // including a plain Employee, could pull the whole roster complete with
    // each person's salary, bank account, IFSC, PAN, UAN, ESI number, date of
    // birth, personal email and emergency contacts.
    const res = await get('/api/v1/employees', ctx.tokens.bob);
    expect(res.status).toBe(200);

    const aliceRow = res.body.find((e) => e.id === String(ctx.alice._id));
    expect(aliceRow).toBeDefined();
    expect(aliceRow.name).toBe('Alice'); // directory data stays visible
    for (const field of SENSITIVE) {
      expect(aliceRow[field]).toBeUndefined();
    }
    expect(aliceRow.redacted).toBe(true);
  });

  it('hides the same fields on the single-employee route', async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.bob);
    expect(res.status).toBe(200);
    for (const field of SENSITIVE) expect(res.body[field]).toBeUndefined();
  });

  it('hides them on the paginated/search path too', async () => {
    const res = await get('/api/v1/employees?page=1&limit=25&search=Alice', ctx.tokens.bob);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].salary).toBeUndefined();
  });

  it('shows an employee their OWN complete record', async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.alice);
    expect(res.status).toBe(200);
    expect(res.body.salary).toBe(150000);
    expect(res.body.bankAccount).toBe('1234567890');
  });

  it("shows a reporting manager their report's working details but NOT their pay", async () => {
    // An earlier revision returned the full record here, including salary.
    // See the "managerId is an organisational relationship" block below for
    // why that was removed and what would have to change to bring it back.
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.manager);
    expect(res.body.name).toBe('Alice');
    expect(res.body.dob).toBe('1992-04-11');       // line-management detail: visible
    expect(res.body.salary).toBeUndefined();       // compensation: not visible
    expect(res.body.bankAccount).toBeUndefined();
  });

  it('does NOT show a manager someone outside their team', async () => {
    const res = await get(`/api/v1/employees/${ctx.bob._id}`, ctx.tokens.manager);
    expect(res.body.salary).toBeUndefined();
    expect(res.body.bankAccount).toBeUndefined();
  });

  it('shows HR and Finance everything', async () => {
    for (const token of [ctx.tokens.hrManager, ctx.tokens.hrDirector, ctx.tokens.financeLead]) {
      const res = await get(`/api/v1/employees/${ctx.alice._id}`, token);
      expect(res.body.salary).toBe(150000);
      expect(res.body.pan).toBe('ABCDE1234F');
    }
  });
});

describe('third-party gateway secrets in settings', () => {
  it('NEVER returns SMTP/Twilio/SendGrid credentials to a plain employee', async () => {
    // GET /settings is readable by every role (the app reads shifts, work week
    // and geofence config from it), and it previously returned the company's
    // live SMTP password, Twilio auth token and SendGrid key in cleartext.
    const res = await get('/api/v1/settings', ctx.tokens.alice);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('super-secret-smtp-password');
    expect(body).not.toContain('twilio-auth-token-value');
    expect(body).not.toContain('SG.real-sendgrid-key');
    expect(body).not.toContain('device-key-value');
    // Non-secret config the app genuinely needs is still there.
    expect(res.body).toHaveProperty('workWeek');
  });

  it('does not return them to an HR Director either — only whether they are set', async () => {
    const res = await get('/api/v1/settings', ctx.tokens.hrDirector);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-smtp-password');
    expect(res.body.secretsConfigured.gatewaySmtpPass).toBe(true);
    expect(res.body.secretsConfigured.gatewayTwilioToken).toBe(true);
  });
});

describe('payroll visibility', () => {
  beforeEach(async () => {
    await Payroll.syncIndexes();
    await Payroll.create({ empId: ctx.alice._id, name: 'Alice', cycle: '2026-07', gross: 150000, net: 120000, company: COMPANY });
    await Payroll.create({ empId: ctx.bob._id, name: 'Bob', cycle: '2026-07', gross: 120000, net: 96000, company: COMPANY });
  });

  it('shows an employee only their own payslip', async () => {
    const res = await get('/api/v1/payroll', ctx.tokens.alice);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].empId).toBe(String(ctx.alice._id));
  });

  it("404s an employee reading someone else's payslip by id", async () => {
    const bobSlip = await Payroll.findOne({ empId: ctx.bob._id });
    const res = await get(`/api/v1/payroll/${bobSlip._id}`, ctx.tokens.alice);
    expect(res.status).toBe(404);
  });

  it('does not let a reporting manager read their report payslips', async () => {
    // Salary is HR/Finance information, not line-management information.
    const res = await get('/api/v1/payroll', ctx.tokens.manager);
    expect(res.body).toHaveLength(0);
  });

  it('lets Finance see every payslip', async () => {
    const res = await get('/api/v1/payroll', ctx.tokens.financeLead);
    expect(res.body).toHaveLength(2);
  });
});

describe('write permissions', () => {
  const cases = [
    { name: 'create employee', method: 'post', path: '/api/v1/employees', body: { name: 'New Hire', role: 'Engineer', dept: 'Eng', loc: 'Remote' }, allowed: ['hrManager', 'hrDirector'], denied: ['alice', 'manager', 'financeLead'] },
    { name: 'create login', method: 'post', path: '/api/v1/users', body: { name: 'X', email: 'newlogin@example.com', password: 'StrongPass123', role: 'Employee' }, allowed: ['hrDirector'], denied: ['alice', 'manager', 'hrManager', 'financeLead'] },
    { name: 'edit settings', method: 'patch', path: '/api/v1/settings', body: { workWeek: '6-day' }, allowed: ['hrManager', 'hrDirector'], denied: ['alice', 'manager', 'financeLead'] },
    { name: 'create role', method: 'post', path: '/api/v1/roles', body: { name: 'Auditor', allowedActions: [] }, allowed: ['hrDirector'], denied: ['alice', 'manager', 'hrManager', 'financeLead'] },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: only the intended roles succeed`, async () => {
      for (const who of testCase.denied) {
        const res = await request(app)[testCase.method](testCase.path)
          .set('Authorization', `Bearer ${ctx.tokens[who]}`)
          .send(testCase.body);
        expect({ who, status: res.status }).toEqual({ who, status: 403 });
      }
      for (const who of testCase.allowed) {
        const res = await request(app)[testCase.method](testCase.path)
          .set('Authorization', `Bearer ${ctx.tokens[who]}`)
          .send({ ...testCase.body, email: testCase.body.email ? `${who}-${testCase.body.email}` : undefined, name: testCase.body.name ? `${testCase.body.name} ${who}` : undefined });
        expect(res.status).toBeLessThan(400);
      }
    });
  }

  it('blocks an employee editing another employee profile (IDOR)', async () => {
    const res = await request(app)
      .patch(`/api/v1/employees/${ctx.bob._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.alice}`)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(403);
    expect((await Employee.findById(ctx.bob._id)).name).toBe('Bob');
  });

  it('blocks an employee raising their own salary through self-service', async () => {
    await request(app)
      .patch(`/api/v1/employees/${ctx.alice._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.alice}`)
      .send({ salary: 9999999, basic: 9999999, role: 'HR Director', pfApplicable: false });

    const stored = await Employee.findById(ctx.alice._id);
    expect(stored.salary).toBe(150000);
    expect(stored.basic).toBe(75000);
    expect(stored.role).not.toBe('HR Director');
    expect(stored.pfApplicable).toBe(true);
  });

  it('lets an employee update their own genuinely self-service fields', async () => {
    const res = await request(app)
      .patch(`/api/v1/employees/${ctx.alice._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.alice}`)
      .send({ phone: '+91 98765 43210', bankAccount: '5555555555' });
    expect(res.status).toBe(200);
    expect((await Employee.findById(ctx.alice._id)).phone).toBe('+91 98765 43210');
  });
});

describe('privilege escalation', () => {
  it('an HR Manager cannot promote themselves to HR Director', async () => {
    const hrUser = await User.findOne({ email: 'hrmgr@example.com' });
    const res = await request(app)
      .patch(`/api/v1/users/${hrUser._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.hrManager}`)
      .send({ role: 'HR Director' });
    expect(res.status).toBe(403);
    expect((await User.findById(hrUser._id)).role).toBe('HR Manager');
  });

  it('an employee cannot grant themselves permissions by editing a role', async () => {
    const employeeRole = await Role.findOne({ name: 'Employee' });
    const res = await request(app)
      .patch(`/api/v1/roles/${employeeRole._id}`)
      .set('Authorization', `Bearer ${ctx.tokens.alice}`)
      .send({ allowedActions: ['manageEmployees', 'managePayroll', 'manageUsers'] });
    expect(res.status).toBe(403);
    expect((await Role.findById(employeeRole._id)).allowedActions).toEqual([]);
  });

  it('a forged token signed with the wrong key is rejected', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign(
      { sub: String((await User.findOne({ email: 'alice@example.com' }))._id), role: 'HR Director', company: COMPANY, tv: 0 },
      'not-the-real-signing-key',
      { expiresIn: '15m' },
    );
    const res = await get('/api/v1/users', forged);
    expect(res.status).toBe(401);
  });

  it('a token claiming a role the account does not hold is corrected server-side', async () => {
    // The stored role wins over the token's copy, so a stale or tampered
    // role claim cannot widen access.
    const jwt = (await import('jsonwebtoken')).default;
    const aliceUser = await User.findOne({ email: 'alice@example.com' });
    const escalated = jwt.sign(
      { sub: String(aliceUser._id), role: 'HR Director', company: COMPANY, employeeId: String(ctx.alice._id), tv: aliceUser.tokenVersion || 0 },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' },
    );
    const res = await get('/api/v1/users', escalated);
    expect(res.status).toBe(403);
  });
});

describe('cross-tenant isolation', () => {
  it("a rival company's HR Director cannot list this company employees", async () => {
    const res = await get('/api/v1/employees', ctx.tokens.rivalDirector);
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === String(ctx.alice._id))).toBe(false);
  });

  it("cannot read this company's employee by id", async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.rivalDirector);
    expect(res.status).toBe(404);
  });

  it("cannot read this company's settings", async () => {
    const res = await get('/api/v1/settings', ctx.tokens.rivalDirector);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-smtp-password');
  });

  it("cannot create payroll against this company's employee", async () => {
    const res = await request(app)
      .post('/api/v1/payroll')
      .set('Authorization', `Bearer ${ctx.tokens.rivalDirector}`)
      .send({ empId: String(ctx.alice._id), cycle: '2026-07', gross: 1 });
    expect(res.status).toBe(404);
  });
});

describe('unauthenticated access', () => {
  const protectedPaths = [
    '/api/v1/employees', '/api/v1/payroll', '/api/v1/leaves', '/api/v1/attendance',
    '/api/v1/users', '/api/v1/settings', '/api/v1/documents', '/api/v1/audit-logs',
    '/api/v1/metrics', '/api/v1/ai/predict',
  ];

  for (const path of protectedPaths) {
    it(`${path} requires authentication`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    });
  }

  it('/api/v1/health stays public for load balancers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect([200, 503]).toContain(res.status);
  });
});

describe('managerId is an organisational relationship, NOT a pay grant', () => {
  // Enterprise manager-self-service practice exposes compensation to a line
  // manager inside a specific workflow (merit cycle, promotion), within HR
  // guardrails — not as always-on directory data. This product has no such
  // workflow, so a manager gets line-management visibility and nothing more.
  // Changing that is a BUSINESS DECISION, and this test is where it would be
  // made explicit.
  it("HIDES a direct report's salary and bank details from their manager", async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.manager);
    expect(res.status).toBe(200);
    for (const field of ['salary', 'basic', 'bankAccount', 'ifsc', 'pan', 'uan', 'esiNumber']) {
      expect(res.body[field], `manager could see "${field}"`).toBeUndefined();
    }
    expect(res.body.redactedFields).toBe('compensation');
  });

  it("still SHOWS the manager the working details line management needs", async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.manager);
    for (const field of ['name', 'role', 'dept', 'status', 'dob', 'phone']) {
      expect(res.body, `manager lost "${field}"`).toHaveProperty(field);
    }
  });

  it('hides even more from someone who is NOT their manager', async () => {
    const res = await get(`/api/v1/employees/${ctx.bob._id}`, ctx.tokens.manager);
    // Outside the team, the personal fields go too — not just compensation.
    expect(res.body.dob).toBeUndefined();
    expect(res.body.phone).toBeUndefined();
    expect(res.body.redacted).toBe(true);
  });

  it('an employee still sees their OWN pay in full', async () => {
    const res = await get(`/api/v1/employees/${ctx.alice._id}`, ctx.tokens.alice);
    expect(res.body.salary).toBe(150000);
    expect(res.body.bankAccount).toBe('1234567890');
  });

  it('HR and Finance are unaffected', async () => {
    for (const token of [ctx.tokens.hrDirector, ctx.tokens.financeLead]) {
      const res = await get(`/api/v1/employees/${ctx.alice._id}`, token);
      expect(res.body.salary).toBe(150000);
    }
  });

  it('a manager cannot read a report payslip either', async () => {
    await Payroll.syncIndexes();
    await Payroll.create({ empId: ctx.alice._id, name: 'Alice', cycle: '2026-09', gross: 150000, net: 120000, company: COMPANY });
    const res = await get('/api/v1/payroll', ctx.tokens.manager);
    expect(res.body).toHaveLength(0);
  });
});
