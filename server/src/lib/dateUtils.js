// Pinned to IST (mirrors nowTimeIST() in shifts.js) — the server may run in
// a different timezone (UTC, e.g. on Render) than the India-based office
// these dates are for. en-CA formats as YYYY-MM-DD directly.
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Pure calendar-date arithmetic on an already-resolved YYYY-MM-DD string —
// no further timezone conversion needed once we have the IST calendar date.
export function isoDateDaysAgo(days, fromISO = todayISO()) {
  const d = new Date(`${fromISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Every YYYY-MM-DD date from startISO to endISO, inclusive.
export function dateRangeInclusive(startISO, endISO) {
  const dates = [];
  const cur = new Date(`${startISO}T00:00:00Z`);
  const end = new Date(`${endISO}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}
