// Shared label/CSS-class mapping for Attendance.status values — used by
// Attendance.jsx, EmployeeProfile.jsx, and MyDashboard.jsx so the same
// status always looks the same everywhere.
export const ATTENDANCE_STATUS = {
  present: { label: 'Present', cls: 'status-active' },
  late: { label: 'Late', cls: 'status-late' },
  absent: { label: 'Absent', cls: 'status-absent' },
  leave: { label: 'On leave', cls: 'status-leave' },
  'early-exit': { label: 'Early exit', cls: 'status-late' },
  'half-day': { label: 'Half day', cls: 'status-half-day' },
  holiday: { label: 'Holiday', cls: 'status-holiday' },
};
