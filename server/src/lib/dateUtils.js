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

// Calculates working days between startISO and endISO, excluding company weekends and official holidays
export function calculateWorkingDays(startISO, endISO, workWeek = '5-day', holidaySet = new Set()) {
  const dates = dateRangeInclusive(startISO, endISO);
  let count = 0;
  for (const dateStr of dates) {
    if (holidaySet.has(dateStr)) continue;
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sun, 6 = Sat
    if (dayOfWeek === 0) continue; // Sunday is non-working for all schemes
    if (workWeek === '5-day' && dayOfWeek === 6) continue; // Saturday non-working for 5-day
    count += 1;
  }
  return count;
}

