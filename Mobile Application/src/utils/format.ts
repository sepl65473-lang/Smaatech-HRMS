import type { Tone } from '../theme';
import type { Settings, Shift } from '../types';

export function formatINR(amount?: number | null): string {
  const value = Math.round(Number(amount) || 0);
  // en-IN grouping (12,34,567) without relying on the device's Intl data.
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}₹${rest ? `${rest},` : ''}${last3}`;
}

export function initialsOf(name?: string): string {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('');
}

// Labels match client/src/lib/attendanceStatus.js.
const ATTENDANCE: Record<string, { label: string; tone: Tone }> = {
  present: { label: 'Present', tone: 'success' },
  late: { label: 'Late', tone: 'warning' },
  absent: { label: 'Absent', tone: 'danger' },
  leave: { label: 'On leave', tone: 'info' },
  'early-exit': { label: 'Early exit', tone: 'warning' },
  'half-day': { label: 'Half day', tone: 'warning' },
  holiday: { label: 'Holiday', tone: 'neutral' },
};
export const attendanceStatus = (status: string) => ATTENDANCE[status] ?? { label: status, tone: 'neutral' as Tone };

const LEAVE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  declined: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
export const leaveStatus = (status: string) => LEAVE[status] ?? { label: status, tone: 'neutral' as Tone };

const PAYROLL: Record<string, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'info' },
  processing: { label: 'Processing', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
};
export const payrollStatus = (status: string) => PAYROLL[status] ?? { label: status, tone: 'neutral' as Tone };

const CORRECTION: Record<string, Tone> = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };
export const correctionTone = (status: string): Tone => CORRECTION[status] ?? 'neutral';

// Same defaults and lookup order as server/src/lib/shifts.js
// resolveShiftForToday. Display only: the server decides lateness itself.
const DEFAULT_SHIFTS: Shift[] = [{ id: 'shift_general', name: 'General', start: '09:00', end: '18:00', graceMins: 15 }];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function shiftForToday(empId: string | null | undefined, settings?: Settings | null): Shift {
  const shifts = settings?.shifts?.length ? settings.shifts : DEFAULT_SHIFTS;
  if (!empId) return shifts[0]!;
  const istDay = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCDay();
  const wanted = settings?.roster?.[empId]?.[WEEKDAYS[istDay]!] || settings?.employeeShifts?.[empId];
  return shifts.find((s) => s.id === wanted) ?? shifts[0]!;
}

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
