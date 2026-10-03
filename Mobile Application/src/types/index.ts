// Shapes returned by the existing HRMS API (server/src/models/*.js toJSON).

export type Role = 'HR Director' | 'HR Manager' | 'Finance Lead' | 'Employee' | (string & {});

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  initials?: string;
  employeeId?: string | null;
  mustChangePassword?: boolean;
  company?: string;
}

export interface Employee {
  id: string;
  name: string;
  role?: string; // designation
  dept?: string;
  loc?: string;
  email?: string;
  phone?: string;
  status?: string;
  joinDate?: string;
  employmentType?: string;
  employmentStage?: string;
  photo?: string;
  managerId?: string | null;
  dob?: string;
  gender?: string;
  bloodGroup?: string;
  personalEmail?: string;
  emergencyContact?: { name?: string; relation?: string; phone?: string };
  bankName?: string;
  bankAccount?: string;
  ifsc?: string;
  pan?: string;
  uan?: string;
  salary?: number;
  redacted?: boolean;
}

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'leave' | 'early-exit' | 'half-day' | 'holiday';

export interface Attendance {
  id: string;
  empId: string;
  name?: string;
  dept?: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: AttendanceStatus | string;
  checkInDetails?: string | null;
  checkOutDetails?: string | null;
  checkInAddress?: string | null;
  checkOutAddress?: string | null;
  workedMinutes?: number | null;
  anomalyFlags?: string[];
  failedVerificationCount?: number;
}

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewedBy?: string;
  reviewNote?: string;
  createdAt?: string;
}

export interface Leave {
  id: string;
  empId: string;
  name?: string;
  dept?: string;
  type: string;
  start: string;
  end: string;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn' | 'cancelled' | string;
  declineReason?: string;
  reason?: string;
  isHalfDay?: boolean;
  halfDayTiming?: string;
  workingDays?: number;
  approvalStages?: string[];
  currentStage?: number;
  approvals?: { role?: string; decision?: string; by?: string; note?: string; at?: string }[];
  createdAt?: string;
}

export interface LeaveType {
  code: string;
  name: string;
  paid: boolean;
  allowHalfDay: boolean;
  maxConsecutiveDays: number;
  documentRequiredAfterDays: number;
}

export interface LeaveBalance {
  type: string;
  name: string;
  paid: boolean;
  annualQuota: number;
  used: number;
  pending: number;
  available: number;
  balanceTracked: boolean;
}

export interface Payroll {
  id: string;
  empId: string;
  name?: string;
  dept?: string;
  gross: number;
  deductions: number;
  net: number;
  status: 'ready' | 'processing' | 'paid' | string;
  cycle: string;
  lopDays?: number;
  lopAmount?: number;
  components?: {
    earnings?: { name?: string; amount: number }[];
    deductions?: { name?: string; amount: number; category?: string }[];
  };
}

export interface AppNotification {
  id: string;
  recipientId?: string | null;
  title: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string;
}

export interface HrDocument {
  id: string;
  title: string;
  owner: string;
  ownerId?: string | null;
  folder: string;
  type: string;
  visibility: string;
  fileRef?: string;
  expiryDate?: string;
  createdAt?: string;
}

export interface Holiday {
  id: string;
  name: string;
  date: string;
  type: string;
}

export interface Shift {
  id: string;
  name: string;
  start: string;
  end: string;
  graceMins?: number;
}

export interface Settings {
  gpsCheckInEnabled: boolean;
  livenessRequired: boolean;
  geofenceRadius?: number;
  orgName?: string;
  workWeek?: string;
  shifts?: Shift[];
  roster?: Record<string, Record<string, string>>;
  employeeShifts?: Record<string, string>;
}

export interface LivenessChallenge {
  challengeId: string;
  action: 'turn-left' | 'turn-right' | 'blink';
  expiresAt: number;
  minFrames: number;
  maxFrames: number;
}

export interface AnalyticsOverview {
  range: { from: string; to: string };
  headcount: { total: number; active: number; exited: number };
  attendance: { marked: number; present: number; late: number; absent: number; onLeave: number; halfDay: number; ratePct: number | null };
  leave: { pending: number; approved: number; declined: number; withdrawn: number; approvedDays: number };
  payroll: { gross: number; deductions: number; net: number; payslips: number; paid: number };
  departments: { dept: string; headcount: number; marked: number; present: number; late: number; absent: number; onLeave: number; ratePct: number | null }[];
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}
