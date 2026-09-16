/**
 * Reading an employee's appraisal rating safely.
 *
 * `rating` is the OUTPUT of a completed review and has no default, so most
 * people simply do not have one. Treating it as a number regardless is what
 * killed the Performance page for every company that had not rated everybody:
 * `e.rating.toFixed(1)` threw on the first unrated employee and the error
 * boundary replaced the entire screen with "Something went wrong".
 *
 * Unrated is presented as unrated. Substituting 0.0 would be worse than the
 * crash — it states on screen that someone was rated zero.
 */

export function isRated(employee) {
  return typeof employee?.rating === 'number' && Number.isFinite(employee.rating);
}

/** Averaged over the people who HAVE a rating; '—' when nobody has. */
export function averageRating(employees = []) {
  const rated = employees.filter(isRated);
  if (!rated.length) return '—';
  return (rated.reduce((sum, e) => sum + e.rating, 0) / rated.length).toFixed(2);
}

/** Rated people first (best first), then the unrated in a stable name order. */
export function rankByRating(employees = []) {
  return [...employees].sort((a, b) => {
    if (isRated(a) && isRated(b)) return b.rating - a.rating;
    if (isRated(a)) return -1;
    if (isRated(b)) return 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}
