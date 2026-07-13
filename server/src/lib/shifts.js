const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const DEFAULT_SHIFTS = [
  { id: 'shift_general', name: 'General', start: '09:00', end: '18:00', graceMins: 15 },
  { id: 'shift_morning', name: 'Morning', start: '06:00', end: '14:00', graceMins: 15 },
  { id: 'shift_evening', name: 'Evening', start: '14:00', end: '22:00', graceMins: 15 },
  { id: 'shift_night', name: 'Night', start: '22:00', end: '06:00', graceMins: 15 },
];

// Mirrors src/lib/shifts.js on the frontend — the server is the one whose
// answer actually counts now, this copy just has to stay behaviorally identical.
export const weekdayKeyOf = (date = new Date()) => WEEKDAY_KEYS[date.getDay()];

export function resolveShiftForToday(empId, settings) {
  const shifts = settings?.shifts?.length ? settings.shifts : DEFAULT_SHIFTS;
  const wanted = settings?.roster?.[empId]?.[weekdayKeyOf()] || settings?.employeeShifts?.[empId];
  return shifts.find((s) => s.id === wanted) || shifts[0];
}

function shiftCutoff(shift) {
  const [h, m] = shift.start.split(':').map(Number);
  const total = h * 60 + m + (shift.graceMins || 0);
  const cutH = Math.floor(total / 60) % 24;
  const cutM = total % 60;
  return `${String(cutH).padStart(2, '0')}:${String(cutM).padStart(2, '0')}`;
}

export function isLate(checkInTime, shift) {
  return checkInTime > shiftCutoff(shift);
}

export function isEarlyExit(checkOutTime, shift) {
  return checkOutTime < shift.end;
}

// Matches the frontend's nowTime() (src/context/HRMSContext.jsx), pinned to
// IST explicitly since the server may not run in the same timezone as the office.
export function nowTimeIST() {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}
