import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  SERVER_DIR, API_PORT, WEB_PORT, API_BASE, WEB_BASE,
  E2E_SECRET, COMPANY, PASSWORD, USERS, waitForHttp, spawnProcess,
} from './fixtures/harness.js';

// mongodb-memory-server, mongoose and bcryptjs are the SERVER's dependencies.
// Resolving them from there keeps one copy of a package that downloads its own
// MongoDB binaries, rather than duplicating it into the client workspace just
// so a test harness can boot a database.
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const importFromServer = (spec) => import(pathToFileURL(serverRequire.resolve(spec)).href);

const { MongoMemoryReplSet } = await importFromServer('mongodb-memory-server');
const mongoose = (await importFromServer('mongoose')).default;
const bcrypt = (await importFromServer('bcryptjs')).default;

/**
 * Boots a COMPLETE, ISOLATED stack for browser E2E:
 *
 *   throwaway MongoDB replica set  ->  real `node src/index.js`  ->  real Vite client
 *
 * Nothing here touches the live Atlas database, and the client is the actual
 * application build, not a mock. The only substitutions are the OTP delivery
 * step and the camera capture, both gated behind lib/e2eGuard.js which cannot
 * activate when NODE_ENV is 'production'.
 */
let replSet;
let server;
let web;

async function seed(uri) {
  await mongoose.connect(uri);
  const load = async (m) => (await import(pathToFileURL(path.join(SERVER_DIR, 'src/models', m)).href)).default;
  const User = await load('User.js');
  const Employee = await load('Employee.js');
  const Settings = await load('Settings.js');
  const Role = await load('Role.js');
  const FaceDescriptor = await load('FaceDescriptor.js');
  const Attendance = await load('Attendance.js');
  const Holiday = await load('Holiday.js');
  const LeaveType = await load('LeaveType.js');
  const { DEFAULT_LEAVE_TYPES } = await import(pathToFileURL(path.join(SERVER_DIR, 'src/models/LeaveType.js')).href);
  const { todayISO } = await import(pathToFileURL(path.join(SERVER_DIR, 'src/lib/dateUtils.js')).href);

  await Settings.create({
    _id: COMPANY,
    gpsCheckInEnabled: false,
    livenessRequired: false,
    workWeek: '5-day',
    approvalWorkflows: { leave: ['Reporting Manager', 'HR Manager'], expense: ['Finance Lead', 'HR Director'] },
  });

  await Role.insertMany([
    { name: 'HR Director', description: 'Admin', allowedPaths: ['*'], allowedActions: ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment', 'managePayroll', 'manageDocuments', 'manageUsers', 'manageRoles', 'manageSettings'] },
    { name: 'HR Manager', description: 'HR', allowedPaths: ['/', '/employees', '/attendance', '/leave', '/resignations'], allowedActions: ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment'] },
    { name: 'Finance Lead', description: 'Finance', allowedPaths: ['/', '/payroll', '/resignations'], allowedActions: ['managePayroll', 'manageDocuments'] },
    // '/resignations' is in the employee's own paths: a person has to be able
    // to file their own exit.
    { name: 'Employee', description: 'ESS', allowedPaths: ['/', '/ess', '/attendance', '/leave', '/resignations'], allowedActions: [] },
  ]);

  await LeaveType.insertMany(DEFAULT_LEAVE_TYPES.map((t) => ({ ...t, company: COMPANY })));
  await Holiday.create({ name: 'E2E Holiday', date: '15 Aug, Fri', company: COMPANY });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const created = {};

  // Manager first: the employee reports to them, which is what exercises the
  // reporting-relationship rules.
  const managerEmp = await Employee.create({
    name: USERS.manager.name, role: 'Engineering Manager', dept: 'Engineering', loc: 'Bengaluru',
    email: USERS.manager.email, status: 'active', company: COMPANY, joinDate: '2021-01-04',
    salary: 200000, basic: 100000, state: 'Karnataka', pan: 'MGRPA1234M', uan: '100200300999',
  });
  created.manager = managerEmp;

  for (const key of ['admin', 'hr', 'employee', 'reportee', 'finance']) {
    const cfg = USERS[key];
    const emp = await Employee.create({
      name: cfg.name,
      role: ['employee', 'reportee'].includes(key) ? 'Engineer' : cfg.role,
      dept: key === 'finance' ? 'Finance & HR' : 'Engineering',
      loc: 'Bengaluru', email: cfg.email, status: 'active', company: COMPANY,
      joinDate: '2022-06-01',
      salary: ['employee', 'reportee'].includes(key) ? 150000 : 180000,
      basic: ['employee', 'reportee'].includes(key) ? 75000 : 90000,
      state: 'Karnataka', pan: 'ABCDE1234F', uan: '100200300400', esiNumber: '3100123456',
      bankAccount: '1234567890', ifsc: 'HDFC0001234',
      dob: '1993-03-12', phone: '+91 90000 00001',
      ...(['employee', 'reportee'].includes(key) ? { managerId: managerEmp._id } : {}),
    });
    created[key] = emp;
  }

  for (const key of Object.keys(USERS)) {
    const cfg = USERS[key];
    const user = await User.create({
      name: cfg.name, email: cfg.email, passwordHash, role: cfg.role,
      company: COMPANY, active: true, employeeId: created[key]._id,
    });
    // A real enrolled template per account, so the identity comparison in the
    // check-in path runs against genuinely distinct faces.
    await FaceDescriptor.create({
      userId: user._id,
      descriptor: Array(128).fill(0.1 + Object.keys(USERS).indexOf(key) * 0.05),
    });
    created[`${key}User`] = user;
  }

  const date = todayISO();
  for (const key of Object.keys(USERS)) {
    await Attendance.create({
      empId: created[key]._id, name: USERS[key].name, dept: created[key].dept,
      date, status: 'absent', company: COMPANY,
    });
  }

  await mongoose.disconnect();
  return created;
}

export default async function globalSetup() {
  console.log('[e2e] starting isolated MongoDB replica set...');
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: '8.2.6' },
    // 10s is the library default and is occasionally not enough on a loaded
    // machine; a slow start must not look like a broken stack.
    instanceOpts: [{ launchTimeout: Number(process.env.MONGOMS_LAUNCH_TIMEOUT || 60000) }],
  });
  const uri = replSet.getUri('e2e_hrms');

  console.log('[e2e] seeding the isolated tenant...');
  await seed(uri);

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: 'e2e'.repeat(24),
    JWT_REFRESH_SECRET: 'e2f'.repeat(24),
    CLIENT_ORIGIN: WEB_BASE,
    METRICS_TOKEN: 'e2e-metrics-token',
    STORAGE_DRIVER: 'gridfs',
    RUN_SCHEDULERS: 'false',
    E2E_TEST_MODE: 'enabled',
    E2E_TEST_SECRET: E2E_SECRET,
  };

  console.log('[e2e] booting the real API server...');
  server = spawnProcess(process.execPath, [path.join(SERVER_DIR, 'src/index.js')], { env, label: 'api' });
  await waitForHttp(`${API_BASE}/api/v1/health`);

  console.log('[e2e] booting the real Vite client...');
  web = spawnProcess('npm', ['run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], {
    shell: process.platform === 'win32', // npm is a shim script on Windows
    cwd: path.resolve(SERVER_DIR, '../client'),
    // No VITE_API_BASE_URL: the client keeps its relative '/api/v1' default
    // and Vite proxies it, so the browser sees ONE origin — which is how a
    // developer actually runs this app, and what the refresh cookie needs.
    env: { ...process.env, VITE_DEV_API_TARGET: API_BASE },
    label: 'web',
  });
  await waitForHttp(WEB_BASE, 120000, { expectOk: false });

  console.log('[e2e] stack ready.');

  globalThis.__E2E__ = { replSet, server, web, uri };
  process.env.E2E_MONGODB_URI = uri;
}
