import { uid, todayISO, DEPARTMENTS } from '../lib/helpers';

// ─────────────────────────────────────────────────────────────
//  Seed dataset — used the first time the app runs (or after reset)
//  Everything downstream (payroll, performance, celebrations) is
//  derived from / consistent with this employee roster.
//
//  Employees + Attendance now live on the real backend (server/, see
//  src/data/store.js) — this file no longer invents its own employee
//  records. `buildSeed(employees)` takes the roster the server returned
//  and links the rest of the (still-local) demo data to those same ids,
//  so payroll/leave/expenses/assets stay consistent with whoever the
//  server says the employees actually are.
// ─────────────────────────────────────────────────────────────

export function buildSeed(employees) {
  const byName = (n) => employees.find(e => e.name === n);

  // ── Leave requests (pending + a little history) ──────────────
  const leaves = [
    { name: 'Priya Sharma',   type: 'sick',   start: '2026-06-02', end: '2026-06-04', status: 'pending', reason: 'Fever and rest advised by doctor.' },
    { name: 'Rohan Kumar',    type: 'earned', start: '2026-06-10', end: '2026-06-14', status: 'pending', reason: 'Family trip booked.' },
    { name: 'Sneha Iyer',     type: 'casual', start: '2026-05-30', end: '2026-05-30', status: 'pending', reason: 'Personal errand.' },
    { name: 'Karan Malhotra', type: 'earned', start: '2026-06-15', end: '2026-06-21', status: 'pending', reason: 'Annual vacation.' },
    { name: 'Pooja Desai',    type: 'casual', start: '2026-06-05', end: '2026-06-06', status: 'pending', reason: 'Home function.' },
    { name: 'Arjun Bhatt',    type: 'sick',   start: '2026-06-03', end: '2026-06-03', status: 'pending', reason: 'Migraine.' },
    { name: 'Kavya Reddy',    type: 'earned', start: '2026-06-17', end: '2026-06-20', status: 'pending', reason: 'Wedding to attend.' },
    { name: 'Meera Singh',    type: 'casual', start: '2026-05-12', end: '2026-05-12', status: 'approved', reason: 'Half-day.' },
    { name: 'Dev Gupta',      type: 'sick',   start: '2026-05-04', end: '2026-05-05', status: 'declined', reason: 'Could not provide cover.' },
  ].map(l => ({
    id: uid('lv'),
    empId: (byName(l.name) || {}).id || null,
    name: l.name,
    dept: (byName(l.name) || {}).dept || '—',
    type: l.type,
    start: l.start,
    end: l.end,
    status: l.status,
    reason: l.reason,
  }));

  // ── Payroll — trailing 12 monthly cycles, so dashboard charts have
  //    real history instead of a single flat month ──────────────
  const monthsAgoCycle = (n) => {
    const d = new Date();
    d.setDate(1); // avoid month-end overflow when stepping back months
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 7); // 'YYYY-MM'
  };
  const PAYROLL_CYCLES = Array.from({ length: 12 }, (_, i) => monthsAgoCycle(11 - i)); // oldest → newest

  const payroll = PAYROLL_CYCLES.flatMap((cycle, cycleIndex) => {
    const monthEnd = `${cycle}-31`;
    const growth = 1 + cycleIndex * 0.006;
    const isLatest = cycleIndex === PAYROLL_CYCLES.length - 1;
    return employees
      .filter(e => (e.joinDate || '9999-99-99') <= monthEnd)
      .map(e => {
        const gross = Math.round(((e.salary || 0) * growth) / 100) * 100;
        const deductions = Math.round(gross * 0.30);
        return {
          id: uid('pay'), empId: e.id, name: e.name, dept: e.dept,
          gross, deductions, net: gross - deductions,
          status: isLatest ? 'ready' : 'paid', // ready | processing | paid
          cycle,
        };
      });
  });

  // ── Celebrations ─────────────────────────────────────────────
  const celebrations = [
    { type: 'birthday', name: 'Ishaan Kapoor',   detail: 'Birthday · Tomorrow' },
    { type: 'anniv',    name: 'Riya Joshi',      detail: '5 years with Smaatech · Fri' },
    { type: 'birthday', name: 'Tanmay Verma',    detail: 'Birthday · Sat' },
    { type: 'anniv',    name: 'Pooja Desai',     detail: '2 years with Smaatech · Sun' },
    { type: 'birthday', name: 'Aditi Rao',       detail: 'Birthday · Mon' },
    { type: 'anniv',    name: 'Karan Malhotra',  detail: '7 years with Smaatech · Tue' },
    { type: 'birthday', name: 'Nikhil Saxena',   detail: 'Birthday · Wed' },
    { type: 'anniv',    name: 'Shruti Pillai',   detail: '1 year with Smaatech · Thu' },
    { type: 'birthday', name: 'Rahul Mehta',     detail: 'Birthday · Jun 8' },
    { type: 'anniv',    name: 'Neha Agarwal',    detail: '3 years with Smaatech · Jun 9' },
    { type: 'birthday', name: 'Aryan Choudhary', detail: 'Birthday · Jun 10' },
    { type: 'anniv',    name: 'Divya Krishnan',  detail: '4 years with Smaatech · Jun 11' },
  ].map(c => ({ id: uid('cel'), ...c, wished: false }));

  // ── Holidays ─────────────────────────────────────────────────
  const holidays = [
    { name: 'Eid al-Adha',       date: '7 Jun, Sun',  type: 'Optional' },
    { name: 'Independence Day',  date: '15 Aug, Sat', type: 'National' },
    { name: 'Janmashtami',       date: '26 Aug, Wed', type: 'Regional' },
    { name: 'Ganesh Chaturthi',  date: '7 Sep, Mon',  type: 'Regional' },
    { name: 'Gandhi Jayanti',    date: '2 Oct, Fri',  type: 'National' },
    { name: 'Diwali',            date: '20 Oct, Tue', type: 'National' },
  ].map(h => ({ id: uid('hol'), ...h }));

  // ── Recruitment (kanban) ─────────────────────────────────────
  const recruitment = [
    { title: 'Senior Backend Engineer', candidate: 'Riya Mehta',   stage: 'Applied',   meta: '2d ago' },
    { title: 'Product Designer',        candidate: 'Tanish Roy',   stage: 'Applied',   meta: '1d ago' },
    { title: 'SDR',                     candidate: 'Anjali Verma', stage: 'Applied',   meta: '3h ago' },
    { title: 'DevOps Engineer',         candidate: 'Sahil Khanna', stage: 'Screening', meta: '4d' },
    { title: 'Content Manager',         candidate: 'Nina Joshi',   stage: 'Screening', meta: '2d' },
    { title: 'Senior Backend Engineer', candidate: 'Aman Sharma',  stage: 'Interview', meta: 'Round 2' },
    { title: 'Product Designer',        candidate: 'Esha Pillai',  stage: 'Interview', meta: 'Round 3' },
    { title: 'HRBP',                    candidate: 'Mihir Patel',  stage: 'Interview', meta: 'Round 1' },
    { title: 'Senior Backend Engineer', candidate: 'Kabir Singh',  stage: 'Offer',     meta: 'Sent' },
    { title: 'Sales Director',          candidate: 'Tara Iyer',    stage: 'Offer',     meta: 'Negotiating' },
    { title: 'Product Designer',        candidate: 'Ayaan Khan',   stage: 'Hired',     meta: 'Joins 1 Jul' },
    { title: 'SDR',                     candidate: 'Diya Rao',     stage: 'Hired',     meta: 'Joins 15 Jun' },
  ].map(r => ({ id: uid('cand'), ...r }));

  // ── Settings ─────────────────────────────────────────────────
  const settings = {
    orgName: 'Smaatech',
    workWeek: '5-day',
    notifyLeave: true,
    notifyPayroll: true,
    notifyBirthday: false,
    twoFactor: true,
    wishesSent: 0,
    totalLeaveDays: 24,
    departments: [...DEPARTMENTS],
    designations: [...new Set(employees.map((e) => e.role))],
    // Gateway Credentials defaults
    gatewayTwilioSid: '',
    gatewayTwilioToken: '',
    gatewayTwilioFrom: '',
    gatewaySendgridKey: '',
    gatewaySmtpHost: '',
    gatewaySmtpUser: '',
    gatewaySmtpPass: '',
    // Dynamic Notification Templates
    notificationTemplates: {
      email: {
        leaveApproval: 'Subject: Leave Approval Notification\n\nDear {employee},\n\nWe are pleased to inform you that your leave request for the period {date} has been approved.\n\nBest regards,\nPeople Operations Team',
        payrollSlip: 'Subject: Monthly Salary Slip Published\n\nDear {employee},\n\nYour salary slip for {date} is now available in your ESS dashboard portal.\n\nBest regards,\nFinance Team'
      },
      sms: {
        leaveApproval: 'Dear {employee}, your leave request for {date} has been approved by Operations. Smaatech',
        payrollSlip: 'Dear {employee}, your payslip for {date} has been processed. Log in to ESS portal to view details. Smaatech'
      },
      whatsapp: {
        leaveApproval: 'Hello *{employee}*,\n\nYour leave request for *{date}* has been *approved* by your supervisor. ✅\n\nRegards,\nHR Operations',
        payrollSlip: 'Hello *{employee}*,\n\nYour salary slip for *{date}* is ready. You can view or download it under your ESS dashboard. 📊'
      }
    },
    // Multi-level approval settings
    approvalWorkflows: {
      leave: ['HR Manager', 'HR Director'],
      expense: ['Finance Lead', 'HR Director']
    }
  };

  // Expenses & Reimbursement Seed
  const expenses = [
    { id: uid('exp'), empId: employees[1].id, name: employees[1].name, category: 'Travel & Lodging', amount: 4500, date: todayISO(), description: 'Travel reimbursement for client meeting in Delhi', receiptUrl: 'https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80', status: 'approved', reason: 'Verified with invoices.' },
    { id: uid('exp'), empId: employees[2].id, name: employees[2].name, category: 'Software Subscription', amount: 12000, date: todayISO(), description: 'Figma Professional yearly license billing', receiptUrl: 'https://images.unsplash.com/photo-1586281380349-632531db7ed4?w=300&q=80', status: 'pending', reason: '' },
    { id: uid('exp'), empId: employees[3].id, name: employees[3].name, category: 'Office Supplies', amount: 1550, date: todayISO(), description: 'Stationery and dry-erase markers for boardrooms', receiptUrl: '', status: 'pending', reason: '' }
  ];

  // Assets Catalog Seed
  const assets = [
    { id: uid('ast'), name: 'MacBook Pro M3 14"', category: 'Laptop', serialNumber: 'MBP-2026-X832', status: 'assigned', assignedToEmpId: employees[0].id, assignedToEmpName: employees[0].name, assignedDate: '2026-06-01' },
    { id: uid('ast'), name: 'Dell UltraSharp 27" 4K', category: 'Monitor', serialNumber: 'DELL-DS27-991A', status: 'assigned', assignedToEmpId: employees[1].id, assignedToEmpName: employees[1].name, assignedDate: '2026-06-05' },
    { id: uid('ast'), name: 'iPhone 15 Pro Max 256GB', category: 'Mobile', serialNumber: 'IPHONE-15-7729', status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '' },
    { id: uid('ast'), name: 'Ergonomic Mesh Chair HNI', category: 'Furniture', serialNumber: 'CHAIR-ERG-09', status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '' }
  ];

  // Job Postings Seed
  const jobs = [
    { id: uid('job'), title: 'Senior Backend Engineer', department: 'Engineering', location: 'Bengaluru', type: 'Full-time', status: 'Open', description: 'Experience with Node.js, WebSockets, and database scaling.' },
    { id: uid('job'), title: 'Lead Product Designer', department: 'Design', location: 'Mumbai', type: 'Full-time', status: 'Open', description: 'Lead our web and mobile UX design system and brand assets.' },
    { id: uid('job'), title: 'Sales Director', department: 'Sales', location: 'Delhi NCR', type: 'Full-time', status: 'Closed', description: 'Enterprise sales strategies and team management.' }
  ];

  return {
    leaves, payroll,
    celebrations, holidays, recruitment, settings,
    reviews: [],
    expenses,
    assets,
    jobs
  };
}
