// ─────────────────────────────────────────────────────────────
//  Shared helpers
// ─────────────────────────────────────────────────────────────

export const initials = (name = '') =>
  name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

const PALETTE = [
  ['#B8541F', '#E8A77A'], ['#5C7A52', '#B8C9A8'], ['#C49B2A', '#E8A77A'],
  ['#A33A2C', '#E8A77A'], ['#6B6457', '#C4B998'],
];

export const gradientFor = (name = '') => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTE[h % PALETTE.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
};

export const formatINR = (n = 0) =>
  '₹ ' + Number(n || 0).toLocaleString('en-IN');

// Collision-resistant id without external deps
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export const formatLongDate = (date = new Date()) =>
  date.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

// Inclusive day count between two ISO dates
export const daysBetween = (startISO, endISO) => {
  if (!startISO || !endISO) return 0;
  const a = new Date(startISO + 'T00:00:00');
  const b = new Date(endISO + 'T00:00:00');
  const diff = Math.round((b - a) / 86400000) + 1;
  return diff > 0 ? diff : 0;
};

export const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

export const LEAVE_TYPES = [
  { value: 'sick',   label: 'Sick leave',   tag: 'tag-sick' },
  { value: 'casual', label: 'Casual leave', tag: 'tag-casual' },
  { value: 'earned', label: 'Earned leave', tag: 'tag-earned' },
];

export const leaveTagClass = (type) =>
  (LEAVE_TYPES.find(t => t.value === type) || {}).tag || 'tag-casual';

export const leaveTagLabel = (type) =>
  (LEAVE_TYPES.find(t => t.value === type) || {}).label || 'Leave';

export const DEPARTMENTS = [
  'Engineering', 'Design', 'Marketing', 'Sales',
  'Operations', 'Finance & HR',
];

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Parses seed-style "7 Jun, Sun" strings into { day, month } (month is 0-indexed)
export const parseHolidayDay = (dateStr) => {
  const m = /(\d{1,2})\s+([A-Za-z]{3})/.exec(dateStr || '');
  if (!m) return null;
  const month = MONTH_NAMES.indexOf(m[2]);
  if (month === -1) return null;
  return { day: Number(m[1]), month };
};

export const LOCATIONS = [
  'Bengaluru', 'Mumbai', 'Hyderabad', 'Delhi NCR',
  'Pune', 'Chennai', 'Remote',
];
