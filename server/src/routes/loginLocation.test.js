// Sign-in location: recorded after a successful sign-in, for visibility only.
// These pin the rules that matter: it can never block or fail a sign-in, the
// address comes from the server's own lookup, a refusal is recorded as a
// refusal, and coordinates are never what a person reading the result sees.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

vi.mock('../lib/geocode.js', () => ({ reverseGeocode: vi.fn() }));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const app = (await import('../app.js')).default;
const User = (await import('../models/User.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const Role = (await import('../models/Role.js')).default;
const AuditLog = (await import('../models/AuditLog.js')).default;
const RefreshToken = (await import('../models/RefreshToken.js')).default;
const { reverseGeocode } = await import('../lib/geocode.js');

const PASSWORD = 'CorrectPass123';
const COMPANY = 'Smaatech';
const OFFICE = { lat: 20.27332, lng: 85.87775 };
const OFFICE_ADDRESS = 'Saheednagar, Khordha, Odisha, India - 751025';

const cookieOf = (res) => {
  const match = /sepl_refresh=([^;,\s]+)/.exec([].concat(res.headers['set-cookie'] || []).join(', '));
  return match ? match[1] : null;
};

let seq = 0;
async function signIn(role = 'Employee') {
  seq += 1;
  const email = `loc${seq}@example.com`;
  await User.create({ name: `Person ${seq}`, email, passwordHash: await bcrypt.hash(PASSWORD, 10), role, company: COMPANY, active: true });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { email, token: login.body.accessToken, cookie: cookieOf(login), userId: login.body.user.id };
}

const report = (session, body) => request(app)
  .post('/api/v1/auth/login-location')
  .set('Authorization', `Bearer ${session.token}`)
  .set('Cookie', `sepl_refresh=${session.cookie}`)
  .send(body);

const lastAudit = (email) => AuditLog.findOne({ action: 'Sign-in location', subject: email }).sort({ createdAt: -1 });

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });

beforeEach(async () => {
  await clearTestDB();
  reverseGeocode.mockReset();
  reverseGeocode.mockImplementation(async () => ({ placeName: 'Saheednagar', fullAddress: 'Saheednagar, Khordha, Odisha, India', display: OFFICE_ADDRESS }));
  // A company site IS configured at the office coordinates, to prove it has no
  // effect on the recorded location.
  await Settings.create({ _id: COMPANY, gpsCheckInEnabled: false, orgName: 'Smaatech Engineering Pvt Ltd', geofenceLat: OFFICE.lat, geofenceLng: OFFICE.lng, geofenceRadius: 50 });
  for (const name of ['HR Director', 'HR Manager', 'Employee']) await Role.create({ name, allowedActions: [] });
});

describe('sign-in never depends on location', () => {
  it('signs in with no location sent at all, and the session simply has none', async () => {
    const session = await signIn();
    const sessions = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${session.token}`).set('Cookie', `sepl_refresh=${session.cookie}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body[0].location).toBeNull();
  });

  it('the login request itself is unchanged: coordinates sent with it are ignored', async () => {
    seq += 1;
    const email = `strict${seq}@example.com`;
    await User.create({ name: 'Strict', email, passwordHash: await bcrypt.hash(PASSWORD, 10), role: 'Employee', company: COMPANY, active: true });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, lat: OFFICE.lat, lng: OFFICE.lng });
    expect(res.status).toBe(200);
    expect((await RefreshToken.findOne({ userId: res.body.user.id })).location).toBeNull();
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it('requires a signed-in session to record a location', async () => {
    const res = await request(app).post('/api/v1/auth/login-location').send(OFFICE);
    expect(res.status).toBe(401);
  });
});

describe('location shared', () => {
  it('stores the server-resolved address of the actual place, with no company name, and audits it', async () => {
    const session = await signIn();
    const res = await report(session, { ...OFFICE, accuracy: 14, timestamp: Date.now() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true, location: OFFICE_ADDRESS });

    const stored = (await RefreshToken.findOne({ userId: session.userId, revokedAt: null })).location;
    expect(stored.status).toBe('shared');
    expect(stored.address).toBe(OFFICE_ADDRESS);
    // Coordinates, accuracy and capture time are kept for audit.
    expect(stored.lat).toBeCloseTo(OFFICE.lat, 5);
    expect(stored.accuracy).toBe(14);
    expect(stored.capturedAt).toBeTruthy();

    const audit = await lastAudit(session.email);
    expect(audit.details).toBe(OFFICE_ADDRESS);
    expect(audit.details).not.toMatch(/\d{2}\.\d{4}/); // no coordinates in what HR reads
  });

  it('another location: the actual place there, by the same rule', async () => {
    reverseGeocode.mockImplementation(async () => ({ placeName: 'Gunupur Town', display: 'Gunupur Town, Rayagada, Odisha, India - 765022' }));
    const session = await signIn();
    const res = await report(session, { lat: 19.09617, lng: 83.81625, accuracy: 30, timestamp: Date.now() });
    expect(res.body.location).toBe('Gunupur Town, Rayagada, Odisha, India - 765022');
  });

  it('a coarse position is marked approximate', async () => {
    const session = await signIn();
    const res = await report(session, { ...OFFICE, accuracy: 1800, timestamp: Date.now() });
    expect(res.body.location).toBe(`${OFFICE_ADDRESS} (approximate, within 1800 m)`);
  });

  it('ignores any address the client sends: only the server lookup is used', async () => {
    const session = await signIn();
    const res = await report(session, { lat: 19.09617, lng: 83.81625, accuracy: 20, address: 'Head Office, Mumbai', location: 'Head Office' });
    expect(res.body.location).toBe(OFFICE_ADDRESS); // what the (mocked) server geocoder returned
  });

  it('keeps the position and says so plainly when the address lookup fails', async () => {
    reverseGeocode.mockImplementation(async () => { throw new Error('provider down'); });
    const session = await signIn();
    const res = await report(session, { lat: 19.09617, lng: 83.81625, accuracy: 20 });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Address unavailable');
    const stored = (await RefreshToken.findOne({ userId: session.userId, revokedAt: null })).location;
    expect(stored.lat).toBeCloseTo(19.09617, 5);
    expect(stored.address).toBeNull();
  });
});

describe('location not shared', () => {
  it.each([
    [{ status: 'denied' }, 'permission denied'],
    [{ status: 'unavailable' }, 'location unavailable on the device'],
    [{}, 'no location received'],
    [{ lat: 123, lng: 500 }, 'no location received'],
  ])('records %j as not shared, never as a place', async (body, reason) => {
    const session = await signIn();
    const res = await report(session, body);
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Location not shared');
    expect(reverseGeocode).not.toHaveBeenCalled();
    expect((await lastAudit(session.email)).details).toBe(`Location not shared (${reason})`);
    // The session is untouched and still works.
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${session.token}`)).status).toBe(200);
  });
});

describe('the record describes the sign-in', () => {
  it('cannot be overwritten by a later call', async () => {
    const session = await signIn();
    await report(session, { ...OFFICE, accuracy: 10 });
    const again = await report(session, { lat: 19.09617, lng: 83.81625, accuracy: 10 });
    expect(again.body.recorded).toBe(false);
    expect(again.body.location).toBe(OFFICE_ADDRESS);
    expect(await AuditLog.countDocuments({ action: 'Sign-in location', subject: session.email })).toBe(1);
  });

  it('carries over when the session token is refreshed', async () => {
    const session = await signIn();
    await report(session, { ...OFFICE, accuracy: 10 });
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', `sepl_refresh=${session.cookie}`).send({});
    expect(refreshed.status).toBe(200);
    const live = await RefreshToken.findOne({ userId: session.userId, revokedAt: null });
    expect(live.location.address).toContain('Saheednagar');
  });

  it('is visible to the person and to HR Director as readable text, without coordinates', async () => {
    const session = await signIn();
    await report(session, { ...OFFICE, accuracy: 10 });
    const admin = await signIn('HR Director');

    const mine = await request(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${session.token}`);
    expect(mine.body[0].location).toBe(OFFICE_ADDRESS);
    expect(JSON.stringify(mine.body)).not.toContain('20.27');

    const theirs = await request(app).get(`/api/v1/users/${session.userId}/sessions`).set('Authorization', `Bearer ${admin.token}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body[0].location).toBe(OFFICE_ADDRESS);
    expect(JSON.stringify(theirs.body)).not.toContain('20.27');

    // A plain employee cannot read someone else's sessions.
    const other = await signIn();
    expect((await request(app).get(`/api/v1/users/${session.userId}/sessions`).set('Authorization', `Bearer ${other.token}`)).status).toBe(403);
  });
});
