// OFFER MANAGEMENT AND HIRING.
//
// Recruitment used to end at a "Hired" column: nothing turned a hired
// candidate into an employee, so the details were re-typed into the employee
// form and the link between the applicant and the person was lost — along with
// any record of what they had actually been offered.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Employee = (await import('../models/Employee.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const Candidate = (await import('../models/Candidate.js')).default;
const LifecycleEvent = (await import('../models/LifecycleEvent.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'HiringCo';

async function ensureRoles() {
  const roles = [
    { name: 'HR Manager', allowedActions: ['manageRecruitment', 'manageEmployees'] },
    { name: 'Employee', allowedActions: [] },
  ];
  for (const role of roles) {
    if (!(await Role.findOne({ name: role.name }))) {
      await Role.create({ description: role.name, allowedPaths: ['/'], ...role });
    }
  }
}

async function seedUser(role) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${role.toLowerCase().replace(/\s+/g, '-')}@hiringco.example.com`;
  await User.create({ name: role, email, passwordHash, role, company: COMPANY, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({
    _id: COMPANY,
    twoFactor: false,
    employmentPolicy: { probationMonths: 6, confirmedByHR: true },
  });
  await ensureRoles();
  const candidate = await Candidate.create({
    title: 'Backend Engineer',
    candidate: 'Asha Rao',
    stage: 'Interview',
    email: 'asha.rao@example.com',
    phone: '+91 90000 00002',
    dept: 'Engineering',
    loc: 'Bengaluru',
    company: COMPANY,
  });
  return { candidate, hr: await seedUser('HR Manager'), employee: await seedUser('Employee') };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
const post = (token, path, body) => request(app).post(`/api/v1${path}`).set(as(token)).send(body || {});

const GOOD_OFFER = { salary: 120000, basic: 60000, joiningDate: '2026-10-01' };

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('issuing an offer', () => {
  it('records what was offered and moves the candidate to the Offer stage', async () => {
    const { hr, candidate } = await seed();
    const res = await post(hr, `/recruitment/${candidate._id}/offer`, { ...GOOD_OFFER, note: 'Standard terms' });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('Offer');
    expect(res.body.offer.salary).toBe(120000);
    expect(res.body.offer.joiningDate).toBe('2026-10-01');
    expect(res.body.offer.status).toBe('sent');
    expect(res.body.offer.sentAt).toBeTruthy();
  });

  it('rejects an offer with no salary or an impossible joining date', async () => {
    const { hr, candidate } = await seed();
    for (const body of [
      { joiningDate: '2026-10-01' },
      { salary: 0, joiningDate: '2026-10-01' },
      { salary: 120000 },
      { salary: 120000, joiningDate: 'soon' },
      { salary: 120000, basic: 500000, joiningDate: '2026-10-01' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(hr, `/recruitment/${candidate._id}/offer`, body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await Candidate.findById(candidate._id)).offer.status).toBe('draft');
  });

  it('cannot be issued by an ordinary employee', async () => {
    const { employee, candidate } = await seed();
    const res = await post(employee, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);
    expect(res.status).toBe(403);
  });

  it('cannot be changed by an ordinary PATCH', async () => {
    const { hr, employee, candidate } = await seed();
    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);

    // Neither role may set the offer through the generic merge-patch: an
    // employee has no access at all, and even HR must go through the endpoint
    // that validates and records the transition.
    expect((await request(app).patch(`/api/v1/recruitment/${candidate._id}`).set(as(employee))
      .send({ offer: { status: 'accepted', salary: 9999999 } })).status).toBe(403);

    await request(app).patch(`/api/v1/recruitment/${candidate._id}`).set(as(hr))
      .send({ offer: { status: 'accepted', salary: 9999999 }, employeeId: '507f1f77bcf86cd799439011' });

    const stored = await Candidate.findById(candidate._id);
    expect(stored.offer.status).toBe('sent');
    expect(stored.offer.salary).toBe(120000);
    expect(stored.employeeId).toBeNull();
  });
});

describe('the candidate response', () => {
  it('records an acceptance', async () => {
    const { hr, candidate } = await seed();
    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);

    const res = await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe('accepted');
    expect(res.body.offer.respondedAt).toBeTruthy();
  });

  it('requires a reason for a decline, and keeps it', async () => {
    const { hr, candidate } = await seed();
    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);

    const noReason = await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'declined' });
    expect(noReason.status).toBe(400);

    const declined = await post(hr, `/recruitment/${candidate._id}/offer/response`, {
      decision: 'declined', reason: 'Accepted another role',
    });
    expect(declined.status).toBe(200);
    expect(declined.body.offer.declineReason).toBe('Accepted another role');
  });

  it('refuses a response when no offer is outstanding', async () => {
    const { hr, candidate } = await seed();
    const res = await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'accepted' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_OPEN_OFFER');
  });

  it('refuses to reissue an offer that has already been accepted', async () => {
    const { hr, candidate } = await seed();
    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);
    await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'accepted' });

    const res = await post(hr, `/recruitment/${candidate._id}/offer`, { ...GOOD_OFFER, salary: 200000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OFFER_ALREADY_ACCEPTED');
  });
});

describe('hiring', () => {
  async function acceptedCandidate(hr, candidate) {
    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);
    await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'accepted' });
  }

  it('creates the employee from the candidate and the accepted offer', async () => {
    const { hr, candidate } = await seed();
    await acceptedCandidate(hr, candidate);

    const res = await post(hr, `/recruitment/${candidate._id}/hire`);
    expect(res.status).toBe(201);

    const { employee } = res.body;
    expect(employee.name).toBe('Asha Rao');
    expect(employee.role).toBe('Backend Engineer');
    expect(employee.dept).toBe('Engineering');
    expect(employee.email).toBe('asha.rao@example.com');
    // The OFFERED salary, not something re-typed.
    expect(employee.salary).toBe(120000);
    expect(employee.basic).toBe(60000);
    expect(employee.joinDate).toBe('2026-10-01');
    // And they start on probation, per the configured policy.
    expect(employee.employmentStage).toBe('Probation');
    expect(employee.probationEndDate).toBe('2027-04-01');

    // The candidate now points at the person they became.
    const stored = await Candidate.findById(candidate._id);
    expect(String(stored.employeeId)).toBe(String(employee.id));
    expect(stored.stage).toBe('Hired');
  });

  it('records the start of employment in the lifecycle history', async () => {
    const { hr, candidate } = await seed();
    await acceptedCandidate(hr, candidate);
    const res = await post(hr, `/recruitment/${candidate._id}/hire`);

    const event = await LifecycleEvent.findOne({ empId: res.body.employee.id, type: 'probation-started' });
    expect(event).toBeTruthy();
    expect(event.effectiveDate).toBe('2026-10-01');
    expect(event.note).toMatch(/Hired from recruitment/);
  });

  it('is idempotent — hiring twice returns the SAME employee', async () => {
    const { hr, candidate } = await seed();
    await acceptedCandidate(hr, candidate);

    const first = await post(hr, `/recruitment/${candidate._id}/hire`);
    const second = await post(hr, `/recruitment/${candidate._id}/hire`);

    expect(second.status).toBe(200);
    expect(second.body.alreadyHired).toBe(true);
    expect(second.body.employee.id).toBe(first.body.employee.id);
    expect(await Employee.countDocuments({ company: COMPANY })).toBe(1);
  });

  it('creates one employee under three simultaneous hire requests', async () => {
    const { hr, candidate } = await seed();
    await acceptedCandidate(hr, candidate);

    await Promise.all([
      post(hr, `/recruitment/${candidate._id}/hire`),
      post(hr, `/recruitment/${candidate._id}/hire`),
      post(hr, `/recruitment/${candidate._id}/hire`),
    ]);
    // The unique (company, email) index is the backstop behind the candidate's
    // own employeeId link.
    expect(await Employee.countDocuments({ company: COMPANY })).toBe(1);
  });

  it('refuses to hire before the offer is accepted', async () => {
    const { hr, candidate } = await seed();
    const noOffer = await post(hr, `/recruitment/${candidate._id}/hire`);
    expect(noOffer.status).toBe(409);
    expect(noOffer.body.error.code).toBe('OFFER_NOT_ACCEPTED');

    await post(hr, `/recruitment/${candidate._id}/offer`, GOOD_OFFER);
    const stillPending = await post(hr, `/recruitment/${candidate._id}/hire`);
    expect(stillPending.status).toBe(409);

    await post(hr, `/recruitment/${candidate._id}/offer/response`, { decision: 'declined', reason: 'Other role' });
    const declined = await post(hr, `/recruitment/${candidate._id}/hire`);
    expect(declined.status).toBe(409);

    expect(await Employee.countDocuments({ company: COMPANY })).toBe(0);
  });

  it('refuses to hire a candidate with no work email', async () => {
    const { hr } = await seed();
    const anonymous = await Candidate.create({
      title: 'Designer', candidate: 'No Email', stage: 'Offer', company: COMPANY,
    });
    await post(hr, `/recruitment/${anonymous._id}/offer`, GOOD_OFFER);
    await post(hr, `/recruitment/${anonymous._id}/offer/response`, { decision: 'accepted' });

    const res = await post(hr, `/recruitment/${anonymous._id}/hire`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_REQUIRED');
  });

  it('refuses a duplicate of an existing employee email', async () => {
    const { hr, candidate } = await seed();
    await Employee.create({
      name: 'Existing Person', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
      email: 'asha.rao@example.com', company: COMPANY,
    });
    await acceptedCandidate(hr, candidate);

    const res = await post(hr, `/recruitment/${candidate._id}/hire`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    expect(await Employee.countDocuments({ company: COMPANY })).toBe(1);
  });

  it('cannot be done by an ordinary employee', async () => {
    const { hr, employee, candidate } = await seed();
    await acceptedCandidate(hr, candidate);
    const res = await post(employee, `/recruitment/${candidate._id}/hire`);
    expect(res.status).toBe(403);
    expect(await Employee.countDocuments({ company: COMPANY })).toBe(0);
  });

  it('never touches a candidate in another company', async () => {
    const { hr } = await seed();
    const outsider = await Candidate.create({
      title: 'Engineer', candidate: 'Other Co Person', stage: 'Offer',
      email: 'other@example.com', company: 'SomeOtherCo',
    });
    expect((await post(hr, `/recruitment/${outsider._id}/offer`, GOOD_OFFER)).status).toBe(404);
    expect((await post(hr, `/recruitment/${outsider._id}/hire`)).status).toBe(404);
  });
});
