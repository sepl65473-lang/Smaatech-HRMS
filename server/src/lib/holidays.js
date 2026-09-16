const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Mirrors client/src/lib/helpers.js's parseHolidayDay — Holiday.date is a
// free-text, year-agnostic display string like "7 Jun, Sun" (recurs every
// year), never a real Date. Returns null if the string doesn't match.
function parseHolidayDay(dateStr) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})/.exec(dateStr || '');
  if (!m) return null;
  const month = MONTH_NAMES.indexOf(m[2]);
  if (month === -1) return null;
  return { day: Number(m[1]), month };
}

// True if `dateISO` (YYYY-MM-DD) falls on any of the given company's holidays.
export function isHoliday(dateISO, holidayDocs) {
  const d = new Date(`${dateISO}T00:00:00`);
  const day = d.getDate();
  const month = d.getMonth();
  return holidayDocs.some((h) => {
    const parsed = parseHolidayDay(h.date);
    return parsed && parsed.day === day && parsed.month === month;
  });
}

// Expands the company's year-agnostic holiday display strings into concrete
// YYYY-MM-DD dates for a given year.
//
// This closes a real, silent bug in leave working-day calculation:
// routes/leave.js built its holiday set with `new Set(holidays.map(h => h.date))`
// and then asked `holidaySet.has('2026-06-07')`. Holiday.date is a display
// string like "7 Jun, Sun" (see the model comment), so that lookup could never
// match ANY date — holidays were never excluded from leave working days, and
// every employee was silently charged leave for company holidays falling
// inside their leave period.
export function holidayDateSet(holidayDocs, year) {
  const set = new Set();
  for (const h of holidayDocs) {
    const parsed = parseHolidayDay(h.date);
    if (!parsed) continue;
    const month = String(parsed.month + 1).padStart(2, '0');
    const day = String(parsed.day).padStart(2, '0');
    set.add(`${year}-${month}-${day}`);
  }
  return set;
}

// Same, but spanning every year a date range touches (a leave that crosses
// 31 December still needs January's holidays).
export function holidayDateSetForRange(holidayDocs, startISO, endISO) {
  const startYear = Number(String(startISO).slice(0, 4));
  const endYear = Number(String(endISO).slice(0, 4));
  const set = new Set();
  for (let year = startYear; year <= endYear; year += 1) {
    for (const date of holidayDateSet(holidayDocs, year)) set.add(date);
  }
  return set;
}
