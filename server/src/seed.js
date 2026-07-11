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

  const employees = await Employee.insertMany(EMP_SEED.map((e, i) => ({
    name: e.name, role: e.role, dept: e.dept, loc: e.loc,
    email: emailOf(e.name), phone: phoneOf(i), status: e.status,
    joinDate: e.join, salary: e.salary, rating: e.rating,
  })));

  const byName = (n) => employees.find((e) => e.name === n);
  await Promise.all(employees.map((e) => {
    const managerName = MANAGER_OF[e.name];
    if (!managerName) return null;
    e.managerId = byName(managerName)._id;
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
