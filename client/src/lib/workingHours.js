/**
 * Formats the total working minutes the server sends on each attendance row
 * (Attendance.workedMinutes — derived from the existing check-in/check-out
 * times). The client never computes attendance itself; it only renders what
 * the server derived, so a report and the screen cannot disagree.
 */
export function formatWorkedMinutes(minutes) {
  if (minutes == null || Number.isNaN(Number(minutes))) return '';
  const total = Number(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
