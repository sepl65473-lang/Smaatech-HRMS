const ROLE_ACCESS = {
  'HR Director': ['*'],
  'HR Manager': [
    '/', '/employees', '/org-chart', '/attendance', '/leave', '/holidays', '/celebrations',
    '/recruitment', '/performance', '/analytics', '/integrations', '/expenses', '/assets', '/workflows', '/resignations'
  ],
  'Finance Lead': ['/', '/payroll', '/documents', '/analytics', '/integrations', '/expenses', '/assets', '/resignations'],
  'Employee': ['/', '/ess', '/holidays', '/org-chart', '/documents', '/expenses', '/resignations'],
};

export const ROLES = Object.keys(ROLE_ACCESS);

export const ROLE_SCOPE = {
  'HR Director': 'Full workspace access',
  'HR Manager': 'People, leave, attendance',
  'Finance Lead': 'Payroll and documents',
  'Employee': 'My profile, leave, attendance, payslips',
};

export const DEFAULT_LOGIN_PROFILES = [
  { id: 'profile_hr_director', name: 'Admin', role: 'HR Director', initials: 'AD', scope: ROLE_SCOPE['HR Director'], email: 'admin@smaatech.co', password: 'Admin@123' },
  { id: 'profile_hr_manager', name: 'Nisha Rao', role: 'HR Manager', initials: 'NR', scope: ROLE_SCOPE['HR Manager'], email: 'hr.manager@smaatech.co', password: 'Manager@123' },
  { id: 'profile_finance_lead', name: 'Kabir Mehta', role: 'Finance Lead', initials: 'KM', scope: ROLE_SCOPE['Finance Lead'], email: 'finance.lead@smaatech.co', password: 'Finance@123' },
  { id: 'profile_employee', name: 'Priya Sharma', role: 'Employee', initials: 'PS', scope: ROLE_SCOPE['Employee'], email: 'priya.sharma@smaatech.co', password: 'Employee@123', empName: 'Priya Sharma' },
];

export const canAccess = (role, path) => {
  const allowed = ROLE_ACCESS[role] || [];
  if (allowed.includes('*')) return true;
  return allowed.includes(path);
};

export const canDo = (role, action) => {
  if (role === 'HR Director') return true;
  const actions = {
    manageEmployees: ['HR Manager'],
    manageAttendance: ['HR Manager'],
    manageLeave: ['HR Manager'],
    manageRecruitment: ['HR Manager'],
    managePayroll: ['Finance Lead'],
    manageDocuments: ['Finance Lead'],
  };
  return (actions[action] || []).includes(role);
};
