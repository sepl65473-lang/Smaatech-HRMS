/**
 * Total working hours for one attendance row, derived from the check-in and
 * check-out times this system already records ("HH:MM", IST — see
 * lib/shifts.js nowTimeIST). Nothing about how a punch is decided or stored
 * changes here; this only reads the two times that are already there.
 *
 * A check-out earlier than the check-in means the shift ran past midnight
 * (the night shift this codebase already supports), so the day wraps once
 * rather than producing a negative total.
 */
const HHMM = /^(\d{1,2}):(\d{2})$/;

function toMinutes(hhmm) {
  const match = HHMM.exec(String(hhmm ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes between check-in and check-out, or null when either is missing. */
export function workedMinutesBetween(checkIn, checkOut) {
  const start = toMinutes(checkIn);
  const end = toMinutes(checkOut);
  if (start == null || end == null) return null;
  const span = end >= start ? end - start : (24 * 60 - start) + end;
  return span;
}

/** "7h 45m" for a report column; empty string when there is nothing to show. */
export function formatWorkedMinutes(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
