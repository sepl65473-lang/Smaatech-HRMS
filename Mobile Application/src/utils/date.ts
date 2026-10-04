// The HRMS keeps attendance dates and times in IST regardless of where the
// phone is (server/src/lib/dateUtils.js todayISO, shifts.js nowTimeIST), so
// "today" here is always the IST calendar day.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function istParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

export function todayIST(): string {
  const { y, m, d } = istParts();
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Current IST time as "HH:MM" (24h), the form the server compares shift times in. */
export function nowTimeIST(): string {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export function monthKeyIST(): string {
  return todayIST().slice(0, 7);
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

export function monthRange(monthKey: string): { from: string; to: string } {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad(last)}` };
}

/** Local calendar date of a picker value as YYYY-MM-DD. */
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toHHMM(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseISO(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** "Mon, 3 Oct" */
export function formatDay(iso?: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const date = parseISO(iso);
  return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "3 Oct 2026" */
export function formatDate(iso?: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const date = parseISO(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatRange(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDay(start)} – ${formatDate(end)}`;
}

/** "October 2026" from "2026-10". */
export function formatMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${full[m - 1] ?? monthKey} ${y}`;
}

/** "09:05" (24h, as stored) to "9:05 AM". */
export function formatTime(hhmm?: string | null): string {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return '—';
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function formatWorked(minutes?: number | null): string {
  if (minutes == null || minutes < 0) return '—';
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(new Date(iso).toISOString());
}

export function greeting(): string {
  const hour = new Date(Date.now() + IST_OFFSET_MS).getUTCHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
