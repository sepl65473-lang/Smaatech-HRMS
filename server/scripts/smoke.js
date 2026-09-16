/**
 * Runtime smoke test.
 *
 * Boots the REAL server process (node src/index.js) against a throwaway
 * MongoDB and exercises it over actual HTTP. The vitest suite drives the
 * Express app in-process via supertest, which never proves that
 * `npm start` itself works — that the startup checks pass, the schedulers
 * register exactly once, the indexes build, and the port actually serves.
 *
 * Usage:  node scripts/smoke.js
 * Exits non-zero on the first failure, so it is CI-usable as-is.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../src/index.js');
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  console.log('Starting a single-node replica set (transactions need one)...');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: '8.2.6' },
  });
  const uri = replSet.getUri('smoke_hrms');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    CLIENT_ORIGIN: 'http://localhost:5173',
    METRICS_TOKEN: 'smoke-metrics-token',
    STORAGE_DRIVER: 'gridfs',
    // Keep the smoke run deterministic: no cron firing mid-test.
    RUN_SCHEDULERS: 'false',
    DISABLE_FACE_WORKER: 'true',
  };

  console.log('Booting the real server process...');
  const server = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  let exitedEarly = null;
  server.on('exit', (code) => { exitedEarly = code; });

  try {
    const health = await waitForHealth();
    check('server boots and /api/v1/health returns ok', health.status === 'ok', `db=${health.db}`);
    check('startup checks did not reject the configuration', exitedEarly === null);

    // ── Seed a user directly, then authenticate over real HTTP ──────────────
    await mongoose.connect(uri);
    const { default: User } = await import('../src/models/User.js');
    const { default: Settings } = await import('../src/models/Settings.js');
    const { default: Role } = await import('../src/models/Role.js');
    const { default: Employee } = await import('../src/models/Employee.js');
    const { default: Payroll } = await import('../src/models/Payroll.js');
    const { default: Attendance } = await import('../src/models/Attendance.js');
    const { default: LeaveBalance } = await import('../src/models/LeaveBalance.js');
    const bcrypt = (await import('bcryptjs')).default;

    await Settings.create({ _id: 'Smaatech', twoFactor: false });
    await Role.create({ name: 'HR Director', allowedActions: ['manageEmployees', 'manageUsers'] });
    await Role.create({ name: 'Employee', allowedActions: [] });
    const emp = await Employee.create({ name: 'Smoke Employee', dept: 'Eng', company: 'Smaatech', salary: 60000, basic: 30000, state: 'Karnataka' });
    await User.create({
      name: 'Smoke Admin', email: 'smoke.admin@example.com',
      passwordHash: await bcrypt.hash('SmokePass123', 10),
      role: 'HR Director', company: 'Smaatech', active: true,
    });
    await User.create({
      name: 'Smoke Employee', email: 'smoke.employee@example.com',
      passwordHash: await bcrypt.hash('SmokePass123', 10),
      role: 'Employee', company: 'Smaatech', active: true, employeeId: emp._id,
    });

    const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke.admin@example.com', password: 'SmokePass123' }),
    });
    const login = await loginRes.json();
    check('login over real HTTP returns an access token', Boolean(login.accessToken));
    const auth = { Authorization: `Bearer ${login.accessToken}` };

    const empLogin = await (await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke.employee@example.com', password: 'SmokePass123' }),
    })).json();
    const empAuth = { Authorization: `Bearer ${empLogin.accessToken}` };

    // ── Reachability of every mounted surface ───────────────────────────────
    const routes = [
      '/api/v1/employees', '/api/v1/attendance', '/api/v1/leaves', '/api/v1/leaves/types',
      '/api/v1/leaves/balance', '/api/v1/payroll', '/api/v1/settings', '/api/v1/documents',
      '/api/v1/audit-logs', '/api/v1/users', '/api/v1/holidays', '/api/v1/device-mappings',
      // A real user id: a nonexistent one legitimately 404s, which would read
      // as "route not mounted" rather than "no such user".
      `/api/v1/face/status/${login.user.id}`,
    ];
    for (const route of routes) {
      const res = await fetch(`${BASE}${route}`, { headers: auth });
      check(`GET ${route} is mounted`, res.status !== 404, `status ${res.status}`);
    }

    // ── Security behaviours over real HTTP ──────────────────────────────────
    const noAuth = await fetch(`${BASE}/api/v1/employees`);
    check('unauthenticated request is rejected', noAuth.status === 401);

    const metricsAnon = await fetch(`${BASE}/api/v1/metrics`);
    check('/metrics is not public', metricsAnon.status === 401);

    const metricsToken = await fetch(`${BASE}/api/v1/metrics`, { headers: { 'X-Metrics-Token': 'smoke-metrics-token' } });
    check('/metrics accepts a valid scrape token', metricsToken.status === 200);

    const settingsAsEmployee = await (await fetch(`${BASE}/api/v1/settings`, { headers: empAuth })).json();
    check('settings response carries no gateway secrets',
      !('gatewaySmtpPass' in settingsAsEmployee) && !('biometricDeviceApiKey' in settingsAsEmployee));

    const rosterAsEmployee = await (await fetch(`${BASE}/api/v1/employees`, { headers: empAuth })).json();
    const otherRow = Array.isArray(rosterAsEmployee) ? rosterAsEmployee.find((e) => e.id !== String(emp._id)) : null;
    check('employee roster hides salary from peers', !otherRow || otherRow.salary === undefined);

    const badOrigin = await fetch(`${BASE}/api/v1/health`, { headers: { Origin: 'https://attacker.vercel.app' } });
    check('a disallowed CORS origin is not reflected back',
      badOrigin.headers.get('access-control-allow-origin') === null);

    const requestId = (await fetch(`${BASE}/api/v1/health`)).headers.get('x-request-id');
    check('every response carries a request id', Boolean(requestId));

    const unknown = await fetch(`${BASE}/api/v1/no-such-route`, { headers: auth });
    check('unknown API route returns a JSON 404', unknown.status === 404
      && (unknown.headers.get('content-type') || '').includes('application/json'));

    // ── Payroll duplicate prevention over real HTTP ─────────────────────────
    const makePayroll = () => fetch(`${BASE}/api/v1/payroll`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId: String(emp._id), cycle: '2026-09', gross: 60000, status: 'ready' }),
    });
    const concurrent = await Promise.all([makePayroll(), makePayroll(), makePayroll(), makePayroll()]);
    const created = concurrent.filter((r) => r.status === 201).length;
    const conflicted = concurrent.filter((r) => r.status === 409).length;
    const payrollCount = await Payroll.countDocuments({ company: 'Smaatech', empId: emp._id, cycle: '2026-09' });
    check('concurrent payroll creation yields exactly one row',
      created === 1 && conflicted === 3 && payrollCount === 1,
      `created=${created} conflicted=${conflicted} rows=${payrollCount}`);

    // ── Statutory computation reached the stored row ────────────────────────
    const slip = await Payroll.findOne({ empId: emp._id, cycle: '2026-09' });
    const pfLine = slip?.components?.deductions?.find((d) => d.category === 'PF');
    check('payroll carries a computed PF deduction', pfLine?.amount === 1800, `pf=${pfLine?.amount}`);

    // ── Indexes actually exist in the database ──────────────────────────────
    const payrollIndexes = await Payroll.collection.indexes();
    check('unique (company, empId, cycle) payroll index exists',
      payrollIndexes.some((i) => i.unique && i.key.company === 1 && i.key.empId === 1 && i.key.cycle === 1));

    const attendanceIndexes = await Attendance.collection.indexes();
    check('unique (empId, date) attendance index exists',
      attendanceIndexes.some((i) => i.unique && i.key.empId === 1 && i.key.date === 1));

    const balanceIndexes = await LeaveBalance.collection.indexes();
    check('unique leave-balance index exists',
      balanceIndexes.some((i) => i.unique && i.key.company === 1 && i.key.empId === 1 && i.key.year === 1 && i.key.type === 1));

    // ── Leave balance is served by the server, not derived client-side ──────
    const balance = await (await fetch(`${BASE}/api/v1/leaves/balance`, { headers: empAuth })).json();
    const casual = balance.balances?.find((b) => b.type === 'casual');
    check('server returns a computed leave balance', Boolean(casual) && typeof casual.available === 'number',
      `casual available=${casual?.available}`);

    // ── Schedulers respected RUN_SCHEDULERS=false ───────────────────────────
    check('schedulers did not start when disabled',
      serverOutput.includes('not the scheduler owner') || !serverOutput.includes('scheduled ('),
      'checked startup log');

    // ── Durable storage round trip through the REAL server ─────────────────
    // The deployed default is Render's ephemeral disk; this proves the gridfs
    // driver actually persists a document into MongoDB and serves it back.
    const docRes = await fetch(`${BASE}/api/v1/documents`, {
      method: 'POST',
      headers: auth,
      body: (() => {
        const form = new FormData();
        form.append('title', 'Smoke Policy');
        form.append('visibility', 'all');
        form.append('file', new Blob([Buffer.from('%PDF-1.4 smoke test body')], { type: 'application/pdf' }), 'policy.pdf');
        return form;
      })(),
    });
    const uploadedDoc = await docRes.json();
    check('document upload succeeds', docRes.status === 201, `status ${docRes.status}`);
    check('file ref is stored in MongoDB (gridfs://), not on ephemeral disk',
      typeof uploadedDoc.fileRef === 'string' && uploadedDoc.fileRef.startsWith('gridfs://'), uploadedDoc.fileRef);

    const dl = await fetch(`${BASE}/api/v1/documents/${uploadedDoc.id}/download`, { headers: auth });
    const dlBody = await dl.text();
    check('document downloads back as the original bytes',
      dl.status === 200 && dlBody.includes('smoke test body'), `status ${dl.status}`);
    check('download is served as a file, not a JSON envelope',
      (dl.headers.get('content-type') || '').includes('application/pdf'));

    const dlAnon = await fetch(`${BASE}/api/v1/documents/${uploadedDoc.id}/download`);
    check('document download rejects anonymous callers', dlAnon.status === 401);

    check('server is still running after the run', exitedEarly === null);
  } finally {
    server.kill('SIGTERM');
    await mongoose.disconnect().catch(() => {});
    await replSet.stop().catch(() => {});
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  if (failures) {
    console.log('\n--- server output ---\n' + serverOutput.slice(-4000));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('SMOKE RUN FAILED:', err);
  process.exit(1);
});
