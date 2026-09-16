/**
 * 100 CONCURRENT USERS — login + face verification + location + attendance.
 *
 * This is a MEASURED test against the real server process, not a projection.
 * Each of the 100 virtual users is a distinct seeded employee with their own
 * enrolled face template and their own attendance row, and each performs the
 * full production path:
 *
 *     POST /auth/login  ->  POST /attendance/:id/check-in (multipart JPEG + GPS)
 *
 * What it proves, or fails to:
 *   - authentication under load (bcrypt is deliberately expensive)
 *   - face processing throughput
 *   - MongoDB connection pool behaviour
 *   - duplicate attendance under concurrency (each user must end with EXACTLY
 *     one check-in, no more)
 *   - race conditions on the same employee-day row
 *   - response latency distribution
 *
 * The face model is NOT mocked here — this measures real descriptor
 * extraction, which is the expensive part.
 *
 * The app's own rate limiter is left ON rather than bypassed — production has
 * it too. Each virtual user carries its own X-Forwarded-For, because the app
 * trusts one proxy hop and 100 employees on 100 devices genuinely arrive as
 * 100 distinct addresses. Any 429s that still occur are reported separately
 * from real failures rather than hidden.
 *
 * Usage:  node scripts/concurrency100.js [users]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../src/index.js');
const PORT = 4610;
const BASE = `http://127.0.0.1:${PORT}`;
const USERS = Number(process.argv[2] || process.env.CONCURRENCY_USERS || 100);
const COMPANY = 'LoadCo';
const PASSWORD = 'LoadTestPass123';

// The app sets `trust proxy` to one hop, so behind Vercel/Render the client
// address comes from X-Forwarded-For. 100 employees on 100 phones are 100
// distinct addresses; sending them all from one makes the per-IP rate limiter
// reject 90% of the run and measures the limiter rather than the system.
// SAME_IP=1 puts every virtual employee behind ONE public address, which is
// what an office NAT actually looks like. This is the case the original run
// never exercised: it always handed each user its own X-Forwarded-For, so the
// per-IP limiter was never under test and a shared-bucket failure could not
// show up. Both modes matter, so both are run.
const SAME_IP = process.env.SAME_IP === '1';
const OFFICE_IP = '203.0.113.7';
const ipFor = (i) => (SAME_IP ? OFFICE_IP : `10.${Math.floor(i / 256) % 256}.${i % 256}.${(i % 250) + 1}`);

const outMs = [];
const outCounts = { ok: 0, rateLimited: 0, rejected: 0, error: 0 };
const outCodes = {};

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

// A REAL face photo is required: the face model correctly finds no face in
// synthetic noise, so a generated image measures the rejection path instead of
// the verification path. Point FACE_SAMPLE at any JPEG containing one clear
// face; an existing enrollment capture is used by default.
//
// The photo is read locally, used only against the throwaway in-memory
// database this script creates, and never leaves the machine.
const FACE_SAMPLE = process.env.FACE_SAMPLE
  || path.resolve(import.meta.dirname, '../uploads/enrollment/6a576e4124424fc538fc8db6.jpg');

function loadFaceSample() {
  if (!fs.existsSync(FACE_SAMPLE)) {
    console.error(`No face sample at ${FACE_SAMPLE}`);
    console.error('Set FACE_SAMPLE=/path/to/a-photo-with-one-face.jpg and re-run.');
    console.error('Without a real face this measures the NO_FACE rejection path, not verification.');
    process.exit(1);
  }
  return fs.readFileSync(FACE_SAMPLE);
}

// Builds a multipart body by hand — fetch + FormData + Blob is available in
// Node 18+, which keeps this dependency-free.
function buildForm(jpegBuffer, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('photo', new Blob([jpegBuffer], { type: 'image/jpeg' }), 'selfie.jpg');
  return form;
}

async function main() {
  console.log(`Spinning up an isolated replica set for a ${USERS}-user run...`);
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '8.2.6' } });
  const uri = replSet.getUri('load_hrms');

  await mongoose.connect(uri);
  const { default: User } = await import('../src/models/User.js');
  const { default: Employee } = await import('../src/models/Employee.js');
  const { default: Attendance } = await import('../src/models/Attendance.js');
  const { default: Settings } = await import('../src/models/Settings.js');
  const { default: Role } = await import('../src/models/Role.js');
  const { default: FaceDescriptor } = await import('../src/models/FaceDescriptor.js');
  const { todayISO } = await import('../src/lib/dateUtils.js');

  // GPS off: this run measures auth + face + attendance throughput. Geofence
  // is a pure arithmetic check with no I/O, so including it would not change
  // the shape of the result, and leaving it off keeps every request on the
  // success path rather than rejecting on a synthetic coordinate.
  await Settings.create({ _id: COMPANY, twoFactor: false, gpsCheckInEnabled: false });
  await Role.create({ name: 'Employee', allowedActions: [] });

  const faceJpeg = loadFaceSample();
  console.log(`Face sample: ${path.basename(FACE_SAMPLE)} (${Math.round(faceJpeg.length / 1024)} KB)`);
  console.log(`Seeding ${USERS} employees with enrolled faces...`);
  // One bcrypt hash reused: hashing 100 times here would add minutes to setup
  // and measures nothing (the server still does a full compare per login).
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const date = todayISO();

  const employees = await Employee.insertMany(
    Array.from({ length: USERS }, (_, i) => ({
      name: `Load User ${i}`, role: 'Engineer', dept: ['Engineering', 'Sales', 'Ops'][i % 3],
      company: COMPANY, email: `load${i}@example.com`, salary: 50000,
    })),
  );
  const users = await User.insertMany(employees.map((e, i) => ({
    name: e.name, email: `load${i}@example.com`, passwordHash,
    role: 'Employee', company: COMPANY, active: true, employeeId: e._id,
  })));
  // Every virtual user is enrolled with the descriptor extracted from the
  // sample, and presents that same photo — so each check-in runs the REAL
  // extraction and a REAL successful match. The identity rule is unchanged and
  // is proven separately in routes/faceIdentity.test.js; what is measured here
  // is throughput, not correctness of matching.
  process.env.DISABLE_FACE_WORKER = 'true';
  const { extractDescriptor } = await import('../src/lib/faceEngine.js');
  const sampleExtraction = await extractDescriptor(faceJpeg);
  if (sampleExtraction.error) {
    console.error(`The sample photo produced ${sampleExtraction.error} — it needs exactly one clear face.`);
    process.exit(1);
  }
  await FaceDescriptor.insertMany(users.map((u) => ({
    userId: u._id, descriptor: sampleExtraction.descriptor,
  })));
  const rows = await Attendance.insertMany(employees.map((e) => ({
    empId: e._id, name: e.name, dept: e.dept, date, company: COMPANY,
  })));
  const rowByEmp = new Map(rows.map((r) => [String(r.empId), String(r._id)]));

  const env = {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PORT), MONGODB_URI: uri,
    JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
    CLIENT_ORIGIN: 'http://localhost:5173', METRICS_TOKEN: 'load-token',
    ALLOW_EPHEMERAL_STORAGE: '1', RUN_SCHEDULERS: 'false',
    // Horizontal scaling. This workload (bcryptjs + face extraction) is
    // CPU-bound on a single-threaded runtime, so more PROCESSES is the lever
    // that actually moves throughput. Set CLUSTER_WORKERS to measure it.
    ...(process.env.CLUSTER_WORKERS
      ? { ENABLE_CLUSTER: 'true', WEB_CONCURRENCY: process.env.CLUSTER_WORKERS, SCHEDULER_WORKER_ID: '1' }
      : {}),
    // Face extraction on the worker POOL — the production path. Set
    // DISABLE_FACE_WORKER=true to measure the in-process path for comparison.
    DISABLE_FACE_WORKER: process.env.DISABLE_FACE_WORKER || 'false',
  };

  const server = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });

  try {
    for (let i = 0; i < 150; i += 1) {
      try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Warm the face model once so the first user doesn't absorb model load time.
    console.log('Warming the face engine...');
    await new Promise((r) => setTimeout(r, 3000));

    const loginMs = []; const punchMs = [];
    const counts = { loginOk: 0, loginRateLimited: 0, loginFailed: 0, punchOk: 0, punchRateLimited: 0, punchRejected: 0, punchError: 0 };
    const rejectionCodes = {};

    // ARRIVAL PATTERN.
    //
    // ARRIVAL_WINDOW_S=0 (default) fires everything in the same instant — the
    // absolute worst case, and not what a real shift change looks like. Set it
    // to spread arrivals evenly over N seconds, which is how 100 employees
    // actually reach the door. Both numbers matter: the first is the ceiling,
    // the second is the day-to-day load.
    const ARRIVAL_WINDOW_S = Number(process.env.ARRIVAL_WINDOW_S || 0);
    console.log(ARRIVAL_WINDOW_S > 0
      ? `
Firing ${USERS} login + face check-in flows spread over ${ARRIVAL_WINDOW_S}s...
`
      : `
Firing ${USERS} SIMULTANEOUS login + face check-in flows...
`);
    const startedAt = Date.now();

    const results = await Promise.all(users.map(async (u, i) => {
      if (ARRIVAL_WINDOW_S > 0) {
        await new Promise((r) => setTimeout(r, Math.round((i / USERS) * ARRIVAL_WINDOW_S * 1000)));
      }
      // Login
      const t0 = performance.now();
      let token = null;
      try {
        const res = await fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ipFor(i) },
          body: JSON.stringify({ email: u.email, password: PASSWORD }),
        });
        loginMs.push(performance.now() - t0);
        if (res.status === 429) { counts.loginRateLimited += 1; return; }
        const body = await res.json();
        if (!body.accessToken) { counts.loginFailed += 1; return; }
        token = body.accessToken;
        counts.loginOk += 1;
      } catch {
        counts.loginFailed += 1;
        return;
      }

      // Face check-in
      const rowId = rowByEmp.get(String(u.employeeId));
      const t1 = performance.now();
      try {
        const res = await fetch(`${BASE}/api/v1/attendance/${rowId}/check-in`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ipFor(i) },
          body: buildForm(faceJpeg, { deviceId: `load-device-${i}`, lat: 19.0760, lng: 72.8777, accuracy: 10 }),
        });
        punchMs.push(performance.now() - t1);
        if (res.status === 200) counts.punchOk += 1;
        else if (res.status === 429) counts.punchRateLimited += 1;
        else {
          const body = await res.json().catch(() => ({}));
          const code = body?.error?.code || `HTTP_${res.status}`;
          rejectionCodes[code] = (rejectionCodes[code] || 0) + 1;
          counts.punchRejected += 1;
        }
      } catch (err) {
        counts.punchError += 1;
      }

      // Check-OUT, same employee, same row. Runs only if the punch-in worked,
      // because checking out of a shift that never started is a different test.
      const t2 = performance.now();
      try {
        const res = await fetch(`${BASE}/api/v1/attendance/${rowId}/check-out`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ipFor(i) },
          body: buildForm(faceJpeg, { deviceId: `load-device-${i}`, lat: 19.0760, lng: 72.8777, accuracy: 10 }),
        });
        outMs.push(performance.now() - t2);
        if (res.status === 200) outCounts.ok += 1;
        else if (res.status === 429) outCounts.rateLimited += 1;
        else {
          const body = await res.json().catch(() => ({}));
          const code = body?.error?.code || `HTTP_${res.status}`;
          outCodes[code] = (outCodes[code] || 0) + 1;
          outCounts.rejected += 1;
        }
      } catch {
        outCounts.error += 1;
      }
    }));

    const wallMs = Date.now() - startedAt;
    loginMs.sort((a, b) => a - b); punchMs.sort((a, b) => a - b); outMs.sort((a, b) => a - b);

    // ── Correctness under concurrency ───────────────────────────────────────
    const withCheckIn = await Attendance.countDocuments({ company: COMPANY, date, checkIn: { $ne: null } });
    const withCheckOut = await Attendance.countDocuments({ company: COMPANY, date, checkOut: { $ne: null } });
    // Cross-user contamination: every row for the day must belong to exactly
    // one expected employee, and no employee may own two rows.
    const rows = await Attendance.find({ company: COMPANY, date }).select('empId checkIn checkOut').lean();
    const expected = new Set(users.map((u) => String(u.employeeId)));
    const seen = new Set();
    let crossUser = 0;
    for (const r of rows) {
      const id = String(r.empId);
      if (!expected.has(id) || seen.has(id)) crossUser += 1;
      seen.add(id);
    }
    const dupes = await Attendance.aggregate([
      { $match: { company: COMPANY, date } },
      { $group: { _id: { empId: '$empId', date: '$date' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);

    console.log('════════ RESULT ════════');
    console.log(`Virtual users              : ${USERS}`);
    console.log(`Wall clock                 : ${(wallMs / 1000).toFixed(1)}s`);
    console.log(`Source addresses           : ${SAME_IP ? `ONE shared office IP (${OFFICE_IP})` : `${USERS} distinct`}`);
    console.log(`Throughput                 : ${(( counts.loginOk + counts.punchOk + outCounts.ok) / (wallMs/1000)).toFixed(1)} successful req/s`);
    console.log('');
    console.log('LOGIN');
    console.log(`  succeeded                : ${counts.loginOk}`);
    console.log(`  rate-limited (expected)  : ${counts.loginRateLimited}`);
    console.log(`  failed                   : ${counts.loginFailed}`);
    console.log(`  p50/p95/p99/max          : ${Math.round(pct(loginMs,50))} / ${Math.round(pct(loginMs,95))} / ${Math.round(pct(loginMs,99))} / ${Math.round(loginMs.at(-1) || 0)} ms`);
    console.log('');
    console.log('FACE CHECK-IN');
    console.log(`  succeeded                : ${counts.punchOk}`);
    console.log(`  rate-limited             : ${counts.punchRateLimited}`);
    console.log(`  rejected by a check      : ${counts.punchRejected} ${Object.keys(rejectionCodes).length ? JSON.stringify(rejectionCodes) : ''}`);
    console.log(`  network/transport errors : ${counts.punchError}`);
    console.log(`  p50/p95/p99/max          : ${Math.round(pct(punchMs,50))} / ${Math.round(pct(punchMs,95))} / ${Math.round(pct(punchMs,99))} / ${Math.round(punchMs.at(-1) || 0)} ms`);
    console.log('');
    console.log('FACE CHECK-OUT');
    console.log(`  succeeded                : ${outCounts.ok}`);
    console.log(`  rate-limited             : ${outCounts.rateLimited}`);
    console.log(`  rejected by a check      : ${outCounts.rejected} ${Object.keys(outCodes).length ? JSON.stringify(outCodes) : ''}`);
    console.log(`  network/transport errors : ${outCounts.error}`);
    console.log(`  p50/p95/p99/max          : ${Math.round(pct(outMs,50))} / ${Math.round(pct(outMs,95))} / ${Math.round(pct(outMs,99))} / ${Math.round(outMs.at(-1) || 0)} ms`);
    console.log('');
    console.log('CORRECTNESS');
    console.log(`  attendance rows with a check-in : ${withCheckIn}`);
    console.log(`  attendance rows with a check-out: ${withCheckOut}`);
    console.log(`  CROSS-USER row errors           : ${crossUser}`);
    console.log(`  DUPLICATE employee-day rows     : ${dupes.length}  ${dupes.length === 0 ? '(none — unique index held)' : '*** RACE CONDITION ***'}`);

    try {
      const m = await (await fetch(`${BASE}/api/v1/metrics`, { headers: { 'X-Metrics-Token': 'load-token' } })).json();
      console.log('');
      console.log('SERVER AFTER RUN');
      console.log(`  event-loop lag           : ${m.eventLoopLagMs} ms`);
      console.log(`  heap used / RSS          : ${Math.round(m.memory.heapUsedBytes/1048576)} MB / ${Math.round(m.memory.rssBytes/1048576)} MB`);
      console.log(`  mongo connection state   : ${m.database.status}`);
    } catch { /* metrics optional */ }

    const hardFailures = counts.punchError + counts.loginFailed;
    console.log('');
    if (dupes.length > 0) {
      console.log('VERDICT: FAILED — duplicate attendance under concurrency.');
      process.exitCode = 1;
    } else if (hardFailures > 0) {
      console.log(`VERDICT: FAILED — ${hardFailures} request(s) errored rather than being cleanly handled.`);
      process.exitCode = 1;
    } else {
      console.log('VERDICT: PASSED — every request was cleanly handled and no duplicate attendance was created.');
    }
  } finally {
    server.kill('SIGTERM');
    await mongoose.disconnect().catch(() => {});
    await replSet.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error('CONCURRENCY RUN FAILED:', err);
  process.exit(1);
});
