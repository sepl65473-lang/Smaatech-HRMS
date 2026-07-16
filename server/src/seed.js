// Seeds the 4 demo login accounts + the employee roster, mirroring
// src/data/seed.js on the frontend so the app shows the same demo data
// it always has — just served from MongoDB instead of localStorage now.
// Safe to re-run: wipes and rebuilds Employee/User/Attendance/Settings.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { connectDB } from './db.js';
import Employee from './models/Employee.js';
import User from './models/User.js';
import Attendance from './models/Attendance.js';
import Settings from './models/Settings.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const emailOf = (name) => `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@smaatech.co`;
const phoneOf = (i) => `+91 9${String(8000000000 + i * 73331).slice(0, 9)}`;

const EMP_SEED = [
  { name: 'Ananya Nair',    role: 'Senior SDE',        dept: 'Engineering',  loc: 'Bengaluru', status: 'active',   join: '2019-03-11', salary: 236666, rating: 4.9 },
  { name: 'Vikram Menon',   role: 'Lead Designer',     dept: 'Design',       loc: 'Mumbai',    status: 'active',   join: '2018-07-02', salary: 200000, rating: 4.8 },
  { name: 'Kavya Reddy',    role: 'Brand Manager',     dept: 'Marketing',    loc: 'Hyderabad', status: 'active',   join: '2021-01-18', salary: 155000, rating: 4.5 },
  { name: 'Dev Gupta',      role: 'Account Executive', dept: 'Sales',        loc: 'Delhi NCR', status: 'active',   join: '2022-06-09', salary: 135000, rating: 4.3 },
  { name: 'Meera Singh',    role: 'Operations Mgr',    dept: 'Operations',   loc: 'Pune',      status: 'active',   join: '2017-11-23', salary: 177500, rating: 4.7 },
  { name: 'Arjun Bhatt',    role: 'DevOps Engineer',   dept: 'Engineering',  loc: 'Remote',    status: 'remote',   join: '2020-09-14', salary: 190000, rating: 4.4 },
  { name: 'Priya Sharma',   role: 'Frontend Engineer', dept: 'Engineering',  loc: 'Bengaluru', status: 'on-leave', join: '2021-04-05', salary: 165000, rating: 4.6 },
  { name: 'Rohan Kumar',    role: 'Product Designer',  dept: 'Design',       loc: 'Mumbai',    status: 'active',   join: '2022-02-21', salary: 148000, rating: 4.2 },
  { name: 'Sneha Iyer',     role: 'Content Lead',      dept: 'Marketing',    loc: 'Chennai',   status: 'active',   join: '2020-05-30', salary: 142000, rating: 4.1 },
  { name: 'Karan Malhotra', role: 'Sales Director',    dept: 'Sales',        loc: 'Delhi NCR', status: 'active',   join: '2016-08-15', salary: 250000, rating: 4.8 },
  { name: 'Pooja Desai',    role: 'Finance Analyst',   dept: 'Finance & HR', loc: 'Mumbai',    status: 'active',   join: '2023-01-09', salary: 138000, rating: 4.0 },
  { name: 'Ishaan Kapoor',  role: 'Backend Engineer',  dept: 'Engineering',  loc: 'Bengaluru', status: 'active',   join: '2021-10-12', salary: 172000, rating: 4.3 },
  { name: 'Aditi Rao',      role: 'HR Business Partner', dept: 'Finance & HR', loc: 'Pune',    status: 'active',   join: '2019-12-01', salary: 158000, rating: 4.4 },
  { name: 'Tanmay Verma',   role: 'QA Engineer',       dept: 'Engineering',  loc: 'Hyderabad', status: 'active',   join: '2022-09-19', salary: 130000, rating: 4.0 },
];

// ── Programmatic generator: expands the 14 hand-written employees above to
// ~150 total, so the dashboard's charts/lists look like a real mid-size org
// instead of a sparse demo roster. ──────────────────────────────────────
const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arnav', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan',
  'Kabir', 'Aryan', 'Dhruv', 'Karthik', 'Nikhil', 'Yash', 'Aman', 'Rahul', 'Varun', 'Siddharth',
  'Ananya', 'Diya', 'Aadhya', 'Myra', 'Anika', 'Riya', 'Ira', 'Saanvi', 'Navya', 'Ishita',
  'Meera', 'Priya', 'Sneha', 'Neha', 'Divya', 'Shruti', 'Tanvi', 'Anjali', 'Kritika', 'Nisha',
  'Ritika', 'Simran', 'Tara', 'Zara', 'Isha', 'Bhavya', 'Charu', 'Esha', 'Falak', 'Gauri',
];
const LAST_NAMES = [
  'Nair', 'Menon', 'Reddy', 'Gupta', 'Singh', 'Bhatt', 'Sharma', 'Kumar', 'Iyer', 'Malhotra',
  'Desai', 'Kapoor', 'Rao', 'Verma', 'Patel', 'Joshi', 'Mehta', 'Agarwal', 'Choudhary', 'Krishnan',
  'Pillai', 'Saxena', 'Chatterjee', 'Banerjee', 'Mukherjee', 'Das', 'Bose', 'Ghosh', 'Chauhan', 'Yadav',
  'Naidu', 'Rana', 'Bajwa', 'Kulkarni', 'Deshpande', 'Rathore', 'Chopra', 'Khanna', 'Sethi', 'Bhatia',
];
const GEN_LOCATIONS = ['Bengaluru', 'Mumbai', 'Hyderabad', 'Delhi NCR', 'Pune', 'Chennai', 'Remote'];

const ROLES_BY_DEPT = {
  Engineering: ['Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'QA Engineer', 'DevOps Engineer', 'Full Stack Developer', 'Mobile Engineer', 'Site Reliability Engineer', 'Engineering Manager'],
  Design: ['UI/UX Designer', 'Product Designer', 'Graphic Designer', 'Visual Designer', 'Motion Designer', 'Design Lead'],
  Marketing: ['Marketing Executive', 'Content Writer', 'SEO Specialist', 'Social Media Manager', 'Growth Marketer', 'Brand Executive'],
  Sales: ['Sales Executive', 'Account Executive', 'Business Development Manager', 'Inside Sales Rep', 'Sales Manager'],
  Operations: ['Operations Executive', 'Operations Analyst', 'Process Coordinator', 'Facilities Executive', 'Logistics Coordinator'],
  'Finance & HR': ['Finance Analyst', 'HR Executive', 'Payroll Specialist', 'Talent Acquisition Specialist', 'Accounts Executive', 'Compliance Officer'],
};
const INTERN_ROLE_BY_DEPT = {
  Engineering: 'Engineering Intern', Design: 'Design Intern', Marketing: 'Marketing Intern',
  Sales: 'Sales Intern', Operations: 'Operations Intern', 'Finance & HR': 'HR Intern',
};
const SALARY_RANGE_BY_DEPT = {
  Engineering: [90000, 260000], Design: [80000, 220000], Marketing: [65000, 180000],
  Sales: [60000, 200000], Operations: [65000, 190000], 'Finance & HR': [70000, 190000],
};
const EMP_TYPE_SALARY_FACTOR = { 'Full-time': 1, 'Part-time': 0.5, Contract: 1.05 };
const INTERN_SALARY_RANGE = [15000, 30000];

// Deterministic target counts (not pure random) so the dashboard's donut
// charts show clean, intentional percentages rather than noisy ones.
const DEPT_COUNTS_EXTRA = { Engineering: 37, Design: 28, Marketing: 21, Sales: 17, Operations: 17, 'Finance & HR': 16 };
const EMPTYPE_COUNTS_EXTRA = { 'Full-time': 91, 'Part-time': 21, Contract: 15, Intern: 9 };
const DEPT_LEAD = {
  Engineering: 'Ananya Nair', Design: 'Vikram Menon', Marketing: 'Kavya Reddy',
  Sales: 'Karan Malhotra', Operations: 'Meera Singh', 'Finance & HR': 'Aditi Rao',
};

const expandCounts = (map) => Object.entries(map).flatMap(([k, n]) => Array(n).fill(k));
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min));

function salaryFor(dept, employmentType) {
  if (employmentType === 'Intern') return Math.round(randInt(...INTERN_SALARY_RANGE) / 500) * 500;
  const [min, max] = SALARY_RANGE_BY_DEPT[dept];
  const factor = EMP_TYPE_SALARY_FACTOR[employmentType] ?? 1;
  return Math.round((randInt(min, max) * factor) / 500) * 500;
}
function weightedStatus() { // 85% active / 10% remote / 5% on-leave
  const r = Math.random();
  return r < 0.85 ? 'active' : r < 0.95 ? 'remote' : 'on-leave';
}
function randomJoinDate() { // 0-10yr ago, biased toward recent years
  const daysAgo = Math.floor((Math.random() ** 1.6) * 3650);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function generateExtraEmployees(count) {
  const deptSlots = shuffle(expandCounts(DEPT_COUNTS_EXTRA));
  const empTypeSlots = shuffle(expandCounts(EMPTYPE_COUNTS_EXTRA));
  const usedNames = new Set(EMP_SEED.map((e) => e.name));
  const rows = [];
  for (let i = 0; i < count; i++) {
    let name;
    do {
      const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
      name = `${first} ${last}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    const dept = deptSlots[i];
    const employmentType = empTypeSlots[i];
    const role = employmentType === 'Intern'
      ? INTERN_ROLE_BY_DEPT[dept]
      : ROLES_BY_DEPT[dept][Math.floor(Math.random() * ROLES_BY_DEPT[dept].length)];

    rows.push({
      name, role, dept,
      loc: GEN_LOCATIONS[Math.floor(Math.random() * GEN_LOCATIONS.length)],
      status: weightedStatus(),
      join: randomJoinDate(),
      salary: salaryFor(dept, employmentType),
      rating: Number((3.5 + Math.random() * 1.5).toFixed(1)),
      employmentType,
    });
  }
  return rows;
}

const ALL_EMP_SEED = [...EMP_SEED, ...generateExtraEmployees(136)];

const MANAGER_OF = {
  'Arjun Bhatt': 'Ananya Nair', 'Priya Sharma': 'Ananya Nair',
  'Ishaan Kapoor': 'Ananya Nair', 'Tanmay Verma': 'Ananya Nair',
  'Rohan Kumar': 'Vikram Menon',
  'Sneha Iyer': 'Kavya Reddy',
  'Dev Gupta': 'Karan Malhotra',
  'Pooja Desai': 'Aditi Rao',
};

const DEMO_ACCOUNTS = [
  { name: 'Admin', role: 'HR Director', initials: 'AD', email: 'admin@smaatech.co', password: 'Admin@123' },
  { name: 'Nisha Rao', role: 'HR Manager', initials: 'NR', email: 'hr.manager@smaatech.co', password: 'Manager@123' },
  { name: 'Kabir Mehta', role: 'Finance Lead', initials: 'KM', email: 'finance.lead@smaatech.co', password: 'Finance@123' },
  { name: 'Priya Sharma', role: 'Employee', initials: 'PS', email: 'priya.sharma@smaatech.co', password: 'Employee@123', empName: 'Priya Sharma' },
];

async function run() {
  await connectDB();

  await Promise.all([
    Employee.deleteMany({}),
    User.deleteMany({}),
    Attendance.deleteMany({}),
    Settings.deleteMany({}),
  ]);

  const employees = await Employee.insertMany(ALL_EMP_SEED.map((e, i) => ({
    name: e.name, role: e.role, dept: e.dept, loc: e.loc,
    email: emailOf(e.name), phone: phoneOf(i), status: e.status,
    joinDate: e.join, salary: e.salary, rating: e.rating,
    employmentType: e.employmentType || 'Full-time',
  })));

  const byName = (n) => employees.find((e) => e.name === n);
  await Promise.all(employees.map((e) => {
    const managerName = MANAGER_OF[e.name] || (e.name !== DEPT_LEAD[e.dept] ? DEPT_LEAD[e.dept] : null);
    if (!managerName) return null;
    const manager = byName(managerName);
    if (!manager) return null;
    e.managerId = manager._id;
    return e.save();
  }));

  await Attendance.insertMany(employees.map((e) => ({
    empId: e._id,
    name: e.name,
    dept: e.dept,
    date: todayISO(),
    checkIn: null,
    checkOut: null,
    status: e.status === 'on-leave' ? 'leave' : 'absent',
  })));

  await User.insertMany(await Promise.all(DEMO_ACCOUNTS.map(async (a) => ({
    name: a.name,
    email: a.email,
    passwordHash: await bcrypt.hash(a.password, 10),
    role: a.role,
    initials: a.initials,
    employeeId: a.empName ? byName(a.empName)._id : null,
  }))));

  await Settings.create({ _id: 'singleton' });

  console.log(`Seeded ${employees.length} employees and ${DEMO_ACCOUNTS.length} demo accounts.`);
  console.log('Demo logins:');
  DEMO_ACCOUNTS.forEach((a) => console.log(`  ${a.role.padEnd(12)} ${a.email}  /  ${a.password}`));
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
