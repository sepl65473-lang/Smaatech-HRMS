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

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const HALF_DAY_MINUTES = 12 * 60;

// Plain "HH:MM" string comparison breaks for a shift that crosses midnight
// (e.g. Night: 22:00-06:00) — "00:30" sorts before "22:15" even though it's
// hours *after* it. For an overnight shift, a time-of-day before noon is
// really the following calendar day relative to the shift's start, so push
// it past the 24h mark and compare everything on one unwrapped timeline.
// Same-day shifts (the common case) are untouched.
function unwrap(minutes, isOvernight) {
  return isOvernight && minutes < HALF_DAY_MINUTES ? minutes + 24 * 60 : minutes;
}

export function isLate(checkInTime, shift) {
  const startMinutes = toMinutes(shift.start);
  const isOvernight = toMinutes(shift.end) <= startMinutes;
  const cutoffMinutes = startMinutes + (shift.graceMins || 0);
  return unwrap(toMinutes(checkInTime), isOvernight) > unwrap(cutoffMinutes, isOvernight);
}

export function isEarlyExit(checkOutTime, shift) {
  const startMinutes = toMinutes(shift.start);
  const endMinutes = toMinutes(shift.end);
  const isOvernight = endMinutes <= startMinutes;
  return unwrap(toMinutes(checkOutTime), isOvernight) < unwrap(endMinutes, isOvernight);
}

// Matches the frontend's nowTime() (src/context/HRMSContext.jsx), pinned to
// IST explicitly since the server may not run in the same timezone as the office.
export function nowTimeIST() {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}
