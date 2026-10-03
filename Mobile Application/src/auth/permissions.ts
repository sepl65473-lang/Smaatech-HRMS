import type { Role, User } from '../types';

// Mirrors the role checks the server already enforces (middleware/auth.js and
// the per-route checks). This only decides what the app OFFERS; every request
// is still authorised by the API, so a wrong answer here can hide a feature
// but can never grant one.
export type Workspace = 'employee' | 'hr' | 'finance';

const HR_ROLES: Role[] = ['HR Director', 'HR Manager'];

export interface Capabilities {
  workspace: Workspace;
  /** Linked to an employee record: has own attendance, leave and payslips. */
  hasEmployeeProfile: boolean;
  isAdmin: boolean;
  /** Company-wide attendance, people directory, corrections, leave decisions. */
  manageWorkforce: boolean;
  /** Every employee's payroll rows (routes/payroll.js PAYROLL_VIEW_ALL). */
  viewAllPayroll: boolean;
  /** routes/analytics.js REPORT_ROLES. */
  viewReports: boolean;
}

export function capabilitiesFor(user: User): Capabilities {
  const isHR = HR_ROLES.includes(user.role);
  const isFinance = user.role === 'Finance Lead';
  return {
    workspace: isHR ? 'hr' : isFinance ? 'finance' : 'employee',
    hasEmployeeProfile: Boolean(user.employeeId),
    isAdmin: user.role === 'HR Director',
    manageWorkforce: isHR,
    viewAllPayroll: isHR || isFinance,
    viewReports: isHR || isFinance,
  };
}

export function roleLabel(role: Role) {
  return role === 'HR Director' ? 'Admin · HR Director' : role;
}
