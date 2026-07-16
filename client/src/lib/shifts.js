const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const DEFAULT_SHIFTS = [
  { id: 'shift_general', name: 'General', start: '09:00', end: '18:00', graceMins: 15 },
  { id: 'shift_morning', name: 'Morning', start: '06:00', end: '14:00', graceMins: 15 },
  { id: 'shift_evening', name: 'Evening', start: '14:00', end: '22:00', graceMins: 15 },
  { id: 'shift_night', name: 'Night', start: '22:00', end: '06:00', graceMins: 15 },
];

export const weekdayKeyOf = (date = new Date()) => WEEKDAY_KEYS[date.getDay()];

export function resolveShiftForToday(empId, settings) {
  const shifts = settings.shifts?.length ? settings.shifts : DEFAULT_SHIFTS;
  const wanted = settings.roster?.[empId]?.[weekdayKeyOf()] || settings.employeeShifts?.[empId];
  return shifts.find((s) => s.id === wanted) || shifts[0];
}

// Adds `graceMins` to a shift's `start` ("HH:MM") and returns "HH:MM" for comparison
// against attendance check-in times (which are also formatted "HH:MM" 24h strings).
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
