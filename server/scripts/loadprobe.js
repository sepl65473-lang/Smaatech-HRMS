/**
 * Small-scale latency probe.
 *
 * WHAT THIS IS: a measurement of relative endpoint cost on one machine, with a
 * small sample, against an in-memory MongoDB. It tells you which endpoints are
 * cheap and which are expensive, and whether cost grows with dataset size.
 *
 * WHAT THIS IS NOT: a capacity test. It cannot tell you how many concurrent
 * users the system supports. Any such number extrapolated from a dev laptop
 * would be invented, so this script deliberately does not produce one.
 *
 * IMPORTANT — REQUEST BUDGET
 * The app rate-limits all of /api/ to 300 requests per 15 minutes
 * (apiLimiter in src/app.js), and /auth/login to 15 (authLimiter). Those
 * limiters are NOT disabled for this probe: a flag that switches off
 * brute-force protection has no business existing in production code.
 *
 * So the scenarios below are budgeted to stay inside the real allowance. An
 * earlier version of this script fired ~3,400 requests, got 429'd on roughly
 * 90% of them, and printed a latency table that was really measuring the cost
 * of returning "429 Too Many Requests". That is why every scenario now asserts
 * a zero error rate and the run aborts if any request fails — a probe that
 * reports latency for failed requests is worse than no probe at all.
 *
 * Usage:  node scripts/loadprobe.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../src/index.js');
const PORT = 4601;
const BASE = `http://127.0.0.1:${PORT}`;
const EMPLOYEE_COUNT = Number(process.env.PROBE_EMPLOYEES || 500);

// Must stay under apiLimiter's 300/15min, with headroom for the health polls
// during startup and the /metrics read at the end.
const API_BUDGET = 300;
let requestsSpent = 0;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Runs one scenario and returns its timings. Throws on the first failed
 * request, carrying the status and body so the cause is obvious rather than
 * being averaged into a misleading latency figure.
 */
async function measure(label, concurrency, iterations, makeRequest) {
  const latencies = [];
  let firstFailure = null;

  const worker = async () => {
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      try {
        const res = await makeRequest();
        const body = await res.text();
        if (!res.ok && !firstFailure) {
          firstFailure = { status: res.status, body: body.slice(0, 300) };
        }
      } catch (err) {
        if (!firstFailure) firstFailure = { status: 'network', body: err.message };
      }
      latencies.push(performance.now() - t0);
      requestsSpent += 1;
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Math.max(1, Date.now() - started);

  if (firstFailure) {
    throw new Error(
      `Scenario "${label}" (concurrency ${concurrency}) had failing requests.\n`
      + `  First failure: HTTP ${firstFailure.status}\n  ${firstFailure.body}\n`
      + `  Requests spent so far: ${requestsSpent}/${API_BUDGET}.\n`
      + '  A 429 here means the probe exceeded the app rate limit — lower the\n'
      + '  iteration counts rather than disabling the limiter.',
    );
  }

  latencies.sort((a, b) => a - b);
  return {
    endpoint: label,
    conc: concurrency,
    reqs: latencies.length,
    rps: Math.round((latencies.length / wallMs) * 1000),
    p50ms: Math.round(percentile(latencies, 50)),
    p95ms: Math.round(percentile(latencies, 95)),
    p99ms: Math.round(percentile(latencies, 99)),
    maxms: Math.round(latencies[latencies.length - 1] || 0),
  };
}

function printTable(rows) {
  if (!rows.length) return;
  const head = Object.keys(rows[0]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(Object.values(r)));
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.2.6' } });
  const uri = replSet.getUri('probe_hrms');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    CLIENT_ORIGIN: 'http://localhost:5173',
    METRICS_TOKEN: 'probe-token',
    ALLOW_EPHEMERAL_STORAGE: '1',
    RUN_SCHEDULERS: 'false',
    DISABLE_FACE_WORKER: 'true',
  };

  console.log(`Seeding ${EMPLOYEE_COUNT} employees and 30 days of attendance...`);
  await mongoose.connect(uri);
  const { default: User } = await import('../src/models/User.js');
  const { default: Settings } = await import('../src/models/Settings.js');
  const { default: Role } = await import('../src/models/Role.js');
  const { default: Employee } = await import('../src/models/Employee.js');
  const { default: Attendance } = await import('../src/models/Attendance.js');

  await Settings.create({ _id: 'Smaatech', twoFactor: false });
  await Role.create({ name: 'HR Director', allowedActions: ['manageEmployees'] });

  const employees = await Employee.insertMany(
    Array.from({ length: EMPLOYEE_COUNT }, (_, i) => ({
      name: `Employee ${i}`,
      dept: ['Engineering', 'Sales', 'Finance & HR'][i % 3],
      company: 'Smaatech',
      salary: 50000 + i,
      basic: 25000,
      state: 'Karnataka',
      email: `probe${i}@example.com`,
    })),
  );

  // 30 days for everyone — the shape a month-end report actually hits.
  const rows = [];
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    for (const emp of employees) {
      rows.push({
        empId: emp._id, name: emp.name, dept: emp.dept, date,
        status: 'present', checkIn: '09:05', checkOut: '18:10', company: 'Smaatech',
      });
    }
  }
  for (let i = 0; i < rows.length; i += 5000) {
    await Attendance.insertMany(rows.slice(i, i + 5000), { ordered: false });
  }
  console.log(`Seeded ${rows.length} attendance rows.\n`);

  await User.create({
    name: 'Probe Admin',
    email: 'probe.admin@example.com',
    passwordHash: await bcrypt.hash('ProbePass123', 10),
    role: 'HR Director',
    company: 'Smaatech',
    active: true,
    // Linked to a real employee: /leaves/balance legitimately 400s for an
    // account with no employee profile, which would fail the probe.
    employeeId: employees[0]._id,
  });

  const server = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });

  try {
    // Startup polling happens BEFORE the budget matters — but it does consume
    // the limiter's allowance, so count it.
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      try {
        const r = await fetch(`${BASE}/api/v1/health`);
        requestsSpent += 1;
        if (r.ok) up = true;
      } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error('server never became healthy');

    const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'probe.admin@example.com', password: 'ProbePass123' }),
    });
    requestsSpent += 1;
    const login = await loginRes.json();
    if (!login.accessToken) throw new Error(`login failed: ${JSON.stringify(login).slice(0, 200)}`);
    const auth = { Authorization: `Bearer ${login.accessToken}` };

    // ── Budgeted scenarios ──────────────────────────────────────────────────
    // Each scenario costs concurrency × iterations requests, so the counts are
    // small on purpose: ~135 total, leaving real headroom under the 300
    // allowance once boot health-polling is included.
    const results = [];

    for (const conc of [1, 10]) {
      results.push(await measure('GET /health', conc, conc === 1 ? 5 : 2, () => fetch(`${BASE}/api/v1/health`)));
    }
    for (const conc of [1, 10]) {
      results.push(await measure(`GET /employees (unpaged, ${EMPLOYEE_COUNT})`, conc, conc === 1 ? 3 : 2,
        () => fetch(`${BASE}/api/v1/employees`, { headers: auth })));
    }
    for (const conc of [1, 10]) {
      results.push(await measure('GET /employees?limit=25', conc, conc === 1 ? 5 : 2,
        () => fetch(`${BASE}/api/v1/employees?page=1&limit=25`, { headers: auth })));
    }
    for (const conc of [1, 10]) {
      results.push(await measure('GET /attendance/summary (30d)', conc, conc === 1 ? 3 : 2,
        () => fetch(`${BASE}/api/v1/attendance/summary?range=Month&from=2026-06-01&to=2026-06-30`, { headers: auth })));
    }
    for (const conc of [1, 10]) {
      results.push(await measure('GET /attendance?limit=50', conc, conc === 1 ? 5 : 2,
        () => fetch(`${BASE}/api/v1/attendance?page=1&limit=50`, { headers: auth })));
    }
    results.push(await measure('GET /leaves/balance', 5, 2,
      () => fetch(`${BASE}/api/v1/leaves/balance`, { headers: auth })));

    // bcrypt is intentionally slow — this shows by how much. authLimiter caps
    // /auth/login at 15, and the sign-in above already used one.
    results.push(await measure('POST /auth/login (bcrypt)', 1, 5, () => fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'probe.admin@example.com', password: 'ProbePass123' }),
    })));

    console.log('MEASURED — single Node process, in-memory MongoDB, one machine.');
    console.log(`Dataset: ${EMPLOYEE_COUNT} employees, ${rows.length} attendance rows.`);
    console.log('Small sample by design (stays inside the app\'s own 300/15min rate limit).');
    console.log('Shows RELATIVE endpoint cost. NOT a capacity projection for 1K/5K/10K users.\n');
    printTable(results);
    console.log(`\nRequest budget used: ${requestsSpent}/${API_BUDGET} (apiLimiter allowance).`);

    // Guarded: a non-2xx here must not crash the summary the way it did before.
    try {
      const metricsRes = await fetch(`${BASE}/api/v1/metrics`, { headers: { 'X-Metrics-Token': 'probe-token' } });
      requestsSpent += 1;
      if (metricsRes.ok) {
        const metrics = await metricsRes.json();
        console.log(`Event-loop lag after the run: ${metrics.eventLoopLagMs}ms`);
        console.log(`Heap used: ${Math.round(metrics.memory.heapUsedBytes / 1024 / 1024)}MB, `
          + `RSS: ${Math.round(metrics.memory.rssBytes / 1024 / 1024)}MB`);
      } else {
        console.log(`(/metrics returned HTTP ${metricsRes.status} — process telemetry not captured.)`);
      }
    } catch (err) {
      console.log(`(/metrics read failed: ${err.message})`);
    }
  } catch (err) {
    console.error(`\nLOAD PROBE FAILED: ${err.message}`);
    console.error('\n--- server output (tail) ---\n' + out.slice(-2000));
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await mongoose.disconnect().catch(() => {});
    await replSet.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error('LOAD PROBE FAILED:', err);
  process.exit(1);
});
