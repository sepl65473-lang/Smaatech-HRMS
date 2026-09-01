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
