// PERFORMANCE REVIEWS.
//
// Two things were wrong here, and the first is the reason these tests exist:
// the PATCH allow-list named fields the schema does not have (`selfReview`,
// `managerReview`, `rating`), so every rating and comment a person typed was
// stripped before it reached the document — while the UI reported success.
// The second is that a REPORTING MANAGER could not write a manager review at
// all; only HR could, which is not what the module is for.
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
const Review = (await import('../models/Review.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;

const PASSWORD = 'CorrectPass123';
const COMPANY = 'ReviewCo';
const CYCLE = 'FY2026 H1';

async function ensureRoles() {
  const roles = [
    { name: 'HR Manager', allowedActions: ['manageEmployees'] },
    { name: 'Employee', allowedActions: [] },
  ];
  for (const role of roles) {
    if (!(await Role.findOne({ name: role.name }))) {
      await Role.create({ description: role.name, allowedPaths: ['/'], ...role });
    }
  }
}

async function seedUser(role, employeeId, label) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const email = `${label.toLowerCase().replace(/\s+/g, '-')}@reviewco.example.com`;
  await User.create({ name: label, email, passwordHash, role, company: COMPANY, active: true, employeeId });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return login.body.accessToken;
}

async function seed() {
  await Settings.create({ _id: COMPANY, twoFactor: false });
  await ensureRoles();

  const manager = await Employee.create({
    name: 'Line Manager', role: 'Engineering Manager', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active',
  });
  const report = await Employee.create({
    name: 'Direct Report', role: 'Engineer', dept: 'Engineering', loc: 'Remote',
    company: COMPANY, status: 'active', managerId: manager._id,
  });
  const stranger = await Employee.create({
    name: 'Someone Else', role: 'Engineer', dept: 'Sales', loc: 'Remote',
    company: COMPANY, status: 'active',
  });

  const review = await Review.create({
    cycleName: CYCLE, empId: report._id, name: report.name, dept: report.dept, company: COMPANY,
  });
  const strangerReview = await Review.create({
    cycleName: CYCLE, empId: stranger._id, name: stranger.name, dept: stranger.dept, company: COMPANY,
  });

  return {
    manager,
    report,
    stranger,
    review,
    strangerReview,
    hr: await seedUser('HR Manager', null, 'HR'),
    managerToken: await seedUser('Employee', manager._id, 'Manager User'),
    employee: await seedUser('Employee', report._id, 'Report User'),
    strangerToken: await seedUser('Employee', stranger._id, 'Stranger User'),
  };
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
const patch = (token, id, body) => request(app).patch(`/api/v1/reviews/${id}`).set(as(token)).send(body);

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('a self review is actually saved', () => {
  it('PERSISTS the rating and comments the employee typed', async () => {
    const { employee, review } = await seed();
    const res = await patch(employee, review._id, {
      selfRating: 4, selfComments: 'Shipped the billing rewrite.', status: 'self-submitted',
    });
    expect(res.status).toBe(200);

    // The whole defect: these were stripped by an allow-list naming fields the
    // schema does not have, and the UI still said "submitted".
    const stored = await Review.findById(review._id);
    expect(stored.selfRating).toBe(4);
    expect(stored.selfComments).toBe('Shipped the billing rewrite.');
    expect(stored.status).toBe('self-submitted');
  });

  it('refuses a rating outside the scale', async () => {
    const { employee, review } = await seed();
    for (const selfRating of [0, 6, -1, 'great']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patch(employee, review._id, { selfRating });
      expect(res.status, `accepted ${selfRating}`).toBe(400);
    }
    expect((await Review.findById(review._id)).selfRating).toBeNull();
  });

  it('does not let an employee write their own MANAGER rating', async () => {
    const { employee, review } = await seed();
    const res = await patch(employee, review._id, { managerRating: 5, managerComments: 'Outstanding' });
    expect(res.status).toBe(403);
    const stored = await Review.findById(review._id);
    expect(stored.managerRating).toBeNull();
  });

  it('does not let an employee mark their own review completed', async () => {
    const { employee, review } = await seed();
    const res = await patch(employee, review._id, { status: 'completed' });
    expect(res.status).toBe(400);
    expect((await Review.findById(review._id)).status).toBe('pending');
  });

  it('does not let an employee touch somebody else review', async () => {
    const { employee, strangerReview } = await seed();
    const res = await patch(employee, strangerReview._id, { selfRating: 5 });
    expect(res.status).toBe(403);
  });
});

describe('the reporting manager can actually review their report', () => {
  it('PERSISTS a manager rating and comments, and completes the review', async () => {
    const { managerToken, review, employee } = await seed();
    await patch(employee, review._id, { selfRating: 4, selfComments: 'Good year', status: 'self-submitted' });

    const res = await patch(managerToken, review._id, {
      managerRating: 5, managerComments: 'Agreed, exceeded the brief.', status: 'completed',
    });
    expect(res.status).toBe(200);

    const stored = await Review.findById(review._id);
    expect(stored.managerRating).toBe(5);
    expect(stored.managerComments).toBe('Agreed, exceeded the brief.');
    expect(stored.status).toBe('completed');
    // The self review is untouched by the manager's submission.
    expect(stored.selfRating).toBe(4);
  });

  it('refuses a manager reviewing someone who is NOT their report', async () => {
    const { managerToken, strangerReview } = await seed();
    const res = await patch(managerToken, strangerReview._id, { managerRating: 1, managerComments: 'x' });
    expect(res.status).toBe(403);
  });

  it('refuses anyone reviewing themselves as their own manager', async () => {
    const { managerToken, manager } = await seed();
    const own = await Review.create({
      cycleName: CYCLE, empId: manager._id, name: manager.name, dept: manager.dept, company: COMPANY,
    });
    const res = await patch(managerToken, own._id, { managerRating: 5, managerComments: 'I am great' });
    expect(res.status).toBe(403);
  });

  it('lets HR act on any review', async () => {
    const { hr, strangerReview } = await seed();
    const res = await patch(hr, strangerReview._id, { managerRating: 3, managerComments: 'Meets expectations' });
    expect(res.status).toBe(200);
    expect((await Review.findById(strangerReview._id)).managerRating).toBe(3);
  });
});

describe('who can read a review', () => {
  it('an employee sees their own and nobody else', async () => {
    const { employee, review, strangerReview } = await seed();

    const list = await request(app).get('/api/v1/reviews').set(as(employee));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(String(review._id));

    // Reading by id directly was unauthorized entirely — any signed-in user
    // could read anyone's ratings and comments.
    const direct = await request(app).get(`/api/v1/reviews/${strangerReview._id}`).set(as(employee));
    expect(direct.status).toBe(403);
  });

  it('a manager sees their own and their team', async () => {
    const { managerToken, review } = await seed();
    const list = await request(app).get('/api/v1/reviews').set(as(managerToken));
    expect(list.body.map((r) => r.id)).toContain(String(review._id));

    const direct = await request(app).get(`/api/v1/reviews/${review._id}`).set(as(managerToken));
    expect(direct.status).toBe(200);
  });

  it('HR sees everything', async () => {
    const { hr } = await seed();
    const list = await request(app).get('/api/v1/reviews').set(as(hr));
    expect(list.body.length).toBeGreaterThanOrEqual(2);
  });

  it('never returns a review from another company', async () => {
    const { hr } = await seed();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Engineer', dept: 'Eng', loc: 'Remote', company: 'OtherCo',
    });
    const theirs = await Review.create({
      cycleName: CYCLE, empId: outsider._id, name: outsider.name, company: 'OtherCo',
    });

    const list = await request(app).get('/api/v1/reviews').set(as(hr));
    expect(list.body.map((r) => r.id)).not.toContain(String(theirs._id));
    expect((await request(app).get(`/api/v1/reviews/${theirs._id}`).set(as(hr))).status).toBe(404);
  });
});

describe('starting a cycle', () => {
  it('refuses a duplicate review for the same employee and cycle', async () => {
    const { hr, report } = await seed();
    const res = await request(app).post('/api/v1/reviews').set(as(hr)).send({
      cycleName: CYCLE, empId: report._id, name: report.name, dept: report.dept,
    });
    expect(res.status).toBe(409);
    expect(await Review.countDocuments({ company: COMPANY, cycleName: CYCLE, empId: report._id })).toBe(1);
  });

  it('creates one review under concurrent starts', async () => {
    const { hr, manager } = await seed();
    const body = { cycleName: CYCLE, empId: manager._id, name: manager.name, dept: manager.dept };
    const results = await Promise.all([
      request(app).post('/api/v1/reviews').set(as(hr)).send(body),
      request(app).post('/api/v1/reviews').set(as(hr)).send(body),
      request(app).post('/api/v1/reviews').set(as(hr)).send(body),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Review.countDocuments({ company: COMPANY, cycleName: CYCLE, empId: manager._id })).toBe(1);
  });

  it('ignores ratings supplied at creation', async () => {
    const { hr, manager } = await seed();
    const res = await request(app).post('/api/v1/reviews').set(as(hr)).send({
      cycleName: 'FY2026 H2', empId: manager._id, name: manager.name,
      selfRating: 5, managerRating: 5, status: 'completed',
    });
    expect(res.status).toBe(201);
    // A review starts empty; it is filled in by the people doing it.
    expect(res.body.selfRating).toBeNull();
    expect(res.body.managerRating).toBeNull();
    expect(res.body.status).toBe('pending');
  });

  it('refuses an employee starting a cycle', async () => {
    const { employee, manager } = await seed();
    const res = await request(app).post('/api/v1/reviews').set(as(employee)).send({
      cycleName: 'Sneaky', empId: manager._id, name: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a review for an employee in another company', async () => {
    const { hr } = await seed();
    const outsider = await Employee.create({
      name: 'Outsider', role: 'Engineer', dept: 'Eng', loc: 'Remote', company: 'OtherCo',
    });
    const res = await request(app).post('/api/v1/reviews').set(as(hr)).send({
      cycleName: CYCLE, empId: outsider._id, name: outsider.name,
    });
    expect(res.status).toBe(404);
  });
});

describe('audit', () => {
  it('records who submitted a review', async () => {
    const { employee, managerToken, review } = await seed();
    await patch(employee, review._id, { selfRating: 4, selfComments: 'ok', status: 'self-submitted' });
    await patch(managerToken, review._id, { managerRating: 4, managerComments: 'agreed', status: 'completed' });

    const logs = await AuditLog.find({ company: COMPANY }).sort({ createdAt: 1 });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('Self review submitted');
    expect(actions).toContain('Manager review submitted');
  });
});
