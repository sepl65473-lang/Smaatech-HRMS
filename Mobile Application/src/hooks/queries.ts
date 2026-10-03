import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  attendanceApi, employeesApi, leaveApi, notificationsApi, settingsApi,
} from '../services/endpoints';
import { announceNew } from '../notifications/local';
import { todayIST } from '../utils/date';

// Shared queries. Keys are listed here so a mutation can invalidate exactly
// what it changed.
export const keys = {
  settings: ['settings'] as const,
  me: (employeeId: string) => ['employee', employeeId] as const,
  today: ['attendance', 'today'] as const,
  attendanceMonth: (month: string) => ['attendance', 'month', month] as const,
  attendanceDay: (date: string) => ['attendance', 'day', date] as const,
  corrections: ['corrections'] as const,
  leaves: (status: string) => ['leaves', status] as const,
  leaveTypes: ['leaveTypes'] as const,
  leaveBalance: (empId: string) => ['leaveBalance', empId] as const,
  payroll: (cycle: string) => ['payroll', cycle] as const,
  notifications: ['notifications'] as const,
  documents: ['documents'] as const,
  holidays: ['holidays'] as const,
  people: (search: string) => ['people', search] as const,
  overview: (from: string, to: string) => ['overview', from, to] as const,
  faceStatus: ['faceStatus'] as const,
};

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: settingsApi.get, staleTime: 5 * 60_000 });
}

export function useMyEmployee(employeeId?: string | null) {
  return useQuery({
    queryKey: keys.me(employeeId ?? 'none'),
    queryFn: () => employeesApi.get(employeeId!),
    enabled: Boolean(employeeId),
    staleTime: 5 * 60_000,
  });
}

/**
 * Today's own attendance row. Listing attendance makes the server create the
 * row for today if it does not exist yet (routes/attendance.js), which is the
 * id a check-in is posted against.
 */
export function useTodayAttendance(employeeId?: string | null) {
  return useQuery({
    queryKey: keys.today,
    queryFn: async () => {
      const today = todayIST();
      const { rows } = await attendanceApi.forEmployee(employeeId!, today, today);
      return rows[0] ?? null;
    },
    enabled: Boolean(employeeId),
    staleTime: 60_000,
  });
}

export function useLeaveBalance(employeeId?: string | null) {
  return useQuery({
    queryKey: keys.leaveBalance(employeeId ?? 'none'),
    queryFn: () => leaveApi.balance(),
    enabled: Boolean(employeeId),
    staleTime: 60_000,
  });
}

/** The inbox, re-checked every two minutes while a screen using it is open. */
export function useNotifications() {
  const query = useQuery({
    queryKey: keys.notifications,
    queryFn: notificationsApi.list,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  useEffect(() => {
    if (query.data) void announceNew(query.data);
  }, [query.data]);
  return query;
}
