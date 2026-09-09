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
import Role from './models/Role.js';
import MasterCategory from './models/MasterCategory.js';
import MasterValue from './models/MasterValue.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const emailOf = (name) => `${name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@smaatech.co`;
const phoneOf = (i) => `+91 9${String(8000000000 + i * 73331).slice(0, 9)}`;

const EMP_SEED = [
  { name: 'Admin',        role: 'HR Director',       dept: 'Finance & HR', loc: 'Bengaluru', status: 'active', join: '2020-01-01', salary: 250000, rating: 5.0 },
  { name: 'Nisha Rao',    role: 'HR Manager',        dept: 'Finance & HR', loc: 'Mumbai',    status: 'active', join: '2021-02-15', salary: 180000, rating: 4.8 },
  { name: 'Kabir Mehta',  role: 'Finance Lead',      dept: 'Finance & HR', loc: 'Delhi NCR', status: 'active', join: '2021-06-10', salary: 190000, rating: 4.7 },
  { name: 'Priya Sharma', role: 'Frontend Engineer', dept: 'Engineering',  loc: 'Bengaluru', status: 'active', join: '2021-04-05', salary: 165000, rating: 4.6 },
];

const ALL_EMP_SEED = EMP_SEED;

const MANAGER_OF = {
  'Arjun Bhatt': 'Ananya Nair', 'Priya Sharma': 'Ananya Nair',
  'Ishaan Kapoor': 'Ananya Nair', 'Tanmay Verma': 'Ananya Nair',
  'Rohan Kumar': 'Vikram Menon',
  'Sneha Iyer': 'Kavya Reddy',
  'Dev Gupta': 'Karan Malhotra',
  'Pooja Desai': 'Aditi Rao',
};

// Demo passwords are read from environment variables or fall back to safe defaults.
const DEFAULT_PASSWORDS = {
  SEED_ADMIN_PASS: 'Admin@123',
  SEED_HR_PASS: 'Manager@123',
  SEED_FINANCE_PASS: 'Finance@123',
  SEED_EMPLOYEE_PASS: 'Employee@123',
};

const DEMO_ACCOUNTS = [
  { name: 'Admin', role: 'HR Director', initials: 'AD', email: 'admin@smaatech.co', envKey: 'SEED_ADMIN_PASS' },
  { name: 'Nisha Rao', role: 'HR Manager', initials: 'NR', email: 'hr.manager@smaatech.co', envKey: 'SEED_HR_PASS' },
  { name: 'Kabir Mehta', role: 'Finance Lead', initials: 'KM', email: 'finance.lead@smaatech.co', envKey: 'SEED_FINANCE_PASS' },
  { name: 'Priya Sharma', role: 'Employee', initials: 'PS', email: 'priya.sharma@smaatech.co', envKey: 'SEED_EMPLOYEE_PASS', empName: 'Priya Sharma' },
].map(acc => {
  const password = process.env[acc.envKey] || DEFAULT_PASSWORDS[acc.envKey];
  const { envKey, ...rest } = acc;
  return { ...rest, password };
});

async function run() {
  await connectDB();

  await Promise.all([
    Employee.deleteMany({}),
    User.deleteMany({}),
    Attendance.deleteMany({}),
    Settings.deleteMany({}),
    Role.deleteMany({}),
    MasterCategory.deleteMany({}),
    MasterValue.deleteMany({}),
  ]);

  const seededCategories = await MasterCategory.insertMany([
    { name: 'Locations', code: 'locations' },
    { name: 'Departments', code: 'departments' },
    { name: 'Document Types', code: 'document_types' },
    { name: 'Genders', code: 'genders' },
    { name: 'Blood Groups', code: 'blood_groups' },
    { name: 'Leave Types', code: 'leave_types' },
    { name: 'Marital Status', code: 'marital_status' },
  ]);

  const catMap = {};
  seededCategories.forEach((c) => { catMap[c.code] = c._id; });

  const valuesToSeed = [
    // Locations
    { categoryId: catMap['locations'], value: 'Bengaluru' },
    { categoryId: catMap['locations'], value: 'Mumbai' },
    { categoryId: catMap['locations'], value: 'Hyderabad' },
    { categoryId: catMap['locations'], value: 'Delhi NCR' },
    { categoryId: catMap['locations'], value: 'Pune' },
    { categoryId: catMap['locations'], value: 'Chennai' },
    { categoryId: catMap['locations'], value: 'Remote' },
    // Departments
    { categoryId: catMap['departments'], value: 'Engineering' },
    { categoryId: catMap['departments'], value: 'Design' },
    { categoryId: catMap['departments'], value: 'Marketing' },
    { categoryId: catMap['departments'], value: 'Sales' },
    { categoryId: catMap['departments'], value: 'Operations' },
    { categoryId: catMap['departments'], value: 'Finance & HR' },
    // Document Types
    { categoryId: catMap['document_types'], value: 'PDF' },
    { categoryId: catMap['document_types'], value: 'DOC' },
    { categoryId: catMap['document_types'], value: 'IMG' },
    { categoryId: catMap['document_types'], value: 'XLS' },
    // Genders
    { categoryId: catMap['genders'], value: 'Male' },
    { categoryId: catMap['genders'], value: 'Female' },
    { categoryId: catMap['genders'], value: 'Other' },
    // Blood Groups
    { categoryId: catMap['blood_groups'], value: 'A+' },
    { categoryId: catMap['blood_groups'], value: 'A-' },
    { categoryId: catMap['blood_groups'], value: 'B+' },
    { categoryId: catMap['blood_groups'], value: 'B-' },
    { categoryId: catMap['blood_groups'], value: 'AB+' },
    { categoryId: catMap['blood_groups'], value: 'AB-' },
    { categoryId: catMap['blood_groups'], value: 'O+' },
    { categoryId: catMap['blood_groups'], value: 'O-' },
    // Leave Types
    { categoryId: catMap['leave_types'], value: 'sick' },
    { categoryId: catMap['leave_types'], value: 'casual' },
    { categoryId: catMap['leave_types'], value: 'earned' },
    // Marital Status
    { categoryId: catMap['marital_status'], value: 'Single' },
    { categoryId: catMap['marital_status'], value: 'Married' },
    { categoryId: catMap['marital_status'], value: 'Divorced' },
    { categoryId: catMap['marital_status'], value: 'Widowed' },
  ];

  await MasterValue.insertMany(valuesToSeed);


  const seededRoles = await Role.insertMany([
    {
      name: 'HR Director',
      description: 'Full workspace access & administrator privileges',
      allowedPaths: ['*'],
      allowedActions: ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment', 'managePayroll', 'manageDocuments'],
    },
    {
      name: 'HR Manager',
      description: 'Manage employee directory, shifts, leaves, recruitment, and reviews',
      allowedPaths: ['/', '/employees', '/org-chart', '/attendance', '/leave', '/holidays', '/celebrations', '/recruitment', '/performance', '/analytics', '/integrations', '/expenses', '/assets', '/workflows', '/resignations'],
      allowedActions: ['manageEmployees', 'manageAttendance', 'manageLeave', 'manageRecruitment'],
    },
    {
      name: 'Finance Lead',
      description: 'Manage payroll run, payslips, assets, expenses, and documents',
      allowedPaths: ['/', '/payroll', '/documents', '/analytics', '/integrations', '/expenses', '/assets', '/resignations'],
      allowedActions: ['managePayroll', 'manageDocuments'],
    },
    {
      name: 'Employee',
      description: 'Employee self-service dashboard, leave applications, documents, and profile',
      allowedPaths: ['/', '/ess', '/holidays', '/org-chart', '/documents', '/expenses', '/resignations', '/attendance'],
      allowedActions: [],
    },
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
