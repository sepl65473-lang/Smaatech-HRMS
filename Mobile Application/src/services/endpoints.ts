import { request } from './api';
import { UPLOAD_TIMEOUT_MS } from '../config/env';
import type {
  AnalyticsOverview, AppNotification, Attendance, AttendanceCorrection, Employee, Holiday, HrDocument,
  FaceLock, Leave, LeaveBalance, LeaveType, LivenessChallenge, Paged, Payroll, Settings, User,
} from '../types';

// Every call here targets an endpoint that already exists in server/src/routes.
// Authorisation is the server's: the app only decides what to offer.

export const authApi = {
  me: () => request<{ user: User }>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  forgotPassword: (email: string) =>
    request<{ ok: true }>('/auth/forgot-password', { method: 'POST', anonymous: true, body: { email } }),
  resetPassword: (email: string, otp: string, newPassword: string) =>
    request<{ ok: true }>('/auth/reset-password', { method: 'POST', anonymous: true, body: { email, otp, newPassword } }),
};

export const settingsApi = {
  get: () => request<Settings>('/settings'),
};

export const employeesApi = {
  get: (id: string) => request<Employee>(`/employees/${id}`),
  search: (params: { page: number; search?: string; dept?: string }) =>
    request<Paged<Employee>>('/employees', { query: { ...params, limit: 25, sort: 'name' } }),
};

// Every /attendance request, reads included, counts against a per-user limit
// of 40 per 15 minutes (server/src/middleware/rateLimits.js), so these calls
// are kept few and their results cached.
const attendancePage = (query: Record<string, string | number | undefined>) =>
  request<Paged<Attendance>>('/attendance', { query });

export const attendanceApi = {
  /**
   * One employee's rows for a date range. A plain employee is always scoped to
   * their own record by the server. For HR the list is company-wide unless the
   * server honours `empId`; an API build that predates that filter is detected
   * (rows for other people come back) and paged through instead, and `partial`
   * reports when that fallback could not reach the end.
   */
  forEmployee: async (empId: string, from: string, to: string): Promise<{ rows: Attendance[]; partial: boolean }> => {
    const first = await attendancePage({ empId, from, to, page: 1, limit: 200 });
    const own = (rows: Attendance[]) => rows.filter((row) => row.empId === empId);
    if (first.rows.every((row) => row.empId === empId)) {
      return { rows: first.rows, partial: first.total > first.rows.length };
    }
    const rows = own(first.rows);
    const MAX_PAGES = 4;
    let page = 1;
    while (page * first.limit < first.total && page < MAX_PAGES) {
      page += 1;
      rows.push(...own((await attendancePage({ from, to, page, limit: 200 })).rows));
    }
    return { rows, partial: page * first.limit < first.total };
  },
  /** Everyone's rows for one day (HR only; others receive just their own). */
  byDate: (date: string, page = 1) => attendancePage({ date, page, limit: 200 }),
  challenge: () => request<LivenessChallenge>('/attendance/liveness/challenge'),
  /** The caller's own face-verification lock. */
  lock: () => request<FaceLock>('/attendance/verification-lock'),
  /** One employee's lock, and its release: HR only, enforced and audited by the server. */
  lockFor: (email: string) => request<FaceLock>('/attendance/verification-lock', { query: { email } }),
  resetLock: (email: string) => request<FaceLock>('/attendance/verification-lock/reset', { method: 'POST', body: { email } }),
  punch: (id: string, direction: 'in' | 'out', form: FormData) =>
    request<Attendance>(`/attendance/${id}/check-${direction}`, { method: 'POST', form, timeoutMs: UPLOAD_TIMEOUT_MS }),
};

export const correctionsApi = {
  list: () => request<AttendanceCorrection[]>('/attendance-corrections'),
  create: (body: { employeeId: string; date: string; requestedCheckIn: string; requestedCheckOut: string; reason: string }) =>
    request<AttendanceCorrection>('/attendance-corrections', { method: 'POST', body }),
  approve: (id: string) => request<AttendanceCorrection>(`/attendance-corrections/${id}/approve`, { method: 'POST', body: {} }),
  reject: (id: string, note: string) =>
    request<AttendanceCorrection>(`/attendance-corrections/${id}/reject`, { method: 'POST', body: { note, reviewNote: note } }),
};

export const faceApi = {
  status: () => request<{ enrolled: boolean; canEnrol: boolean }>('/face/access/me'),
  enroll: (form: FormData) =>
    request<{ ok: true; enrolledFor: string }>('/face/enroll', { method: 'POST', form, timeoutMs: UPLOAD_TIMEOUT_MS }),
};

export const leaveApi = {
  list: (params: { page: number; status?: string }) => request<Paged<Leave>>('/leaves', { query: { ...params, limit: 25 } }),
  types: () => request<LeaveType[]>('/leaves/types'),
  balance: (empId?: string) => request<{ year: number; balances: LeaveBalance[] }>('/leaves/balance', { query: { empId } }),
  create: (body: {
    empId: string; type: string; start: string; end: string; reason: string; isHalfDay: boolean; halfDayTiming?: string;
  }) => request<Leave & { balanceAfter: number | null }>('/leaves', { method: 'POST', body }),
  withdraw: (id: string) => request<Leave>(`/leaves/${id}/withdraw`, { method: 'POST', body: {} }),
  approve: (id: string, note: string) => request<Leave>(`/leaves/${id}/approve`, { method: 'POST', body: { note } }),
  decline: (id: string, note: string) => request<Leave>(`/leaves/${id}/decline`, { method: 'POST', body: { note } }),
};

export const payrollApi = {
  list: (params: { page: number; cycle?: string; limit?: number }) => request<Paged<Payroll>>('/payroll', { query: { limit: 25, ...params } }),
};

export const notificationsApi = {
  list: () => request<AppNotification[]>('/notifications'),
  markRead: (id: string) => request<AppNotification>(`/notifications/${id}/read`, { method: 'PATCH', body: {} }),
  markAllRead: () => request<{ success: true }>('/notifications/read-all', { method: 'PATCH', body: {} }),
};

export const documentsApi = {
  list: (page: number) => request<Paged<HrDocument>>('/documents', { query: { page, limit: 25 } }),
};

export const holidaysApi = {
  list: () => request<Holiday[]>('/holidays'),
};

export const analyticsApi = {
  overview: (from: string, to: string) => request<AnalyticsOverview>('/analytics/overview', { query: { from, to } }),
};
