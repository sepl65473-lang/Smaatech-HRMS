import LeaveBalance from '../models/LeaveBalance.js';
import LeaveLedger from '../models/LeaveLedger.js';
import LeaveType, { DEFAULT_LEAVE_TYPES } from '../models/LeaveType.js';
import logger from './logger.js';

/**
 * The server-side leave balance authority.
 *
 * Every balance movement goes through here, and every movement writes an
 * immutable LeaveLedger row alongside the LeaveBalance update. Nothing else in
 * the codebase may $inc a balance directly.
 *
 * The critical property is that a DEBIT is a single conditional update:
 *
 *     findOneAndUpdate(
 *       { ...key, $expr: { $gte: [available, days] } },
 *       { $inc: { pending: days } },
 *     )
 *
 * Mongo evaluates the sufficiency test and applies the decrement in one
 * atomic document operation, so two requests filed at the same instant cannot
 * both pass a "do they have enough days?" check and both succeed. A
 * read-then-write in application code would.
 */

// Leave year. Configurable per company because Indian companies split roughly
// between the calendar year and the April-March financial year.
export function leaveYearOf(dateISO, startMonth = 1) {
  const [y, m] = String(dateISO).split('-').map(Number);
  if (startMonth <= 1) return y;
  return m >= startMonth ? y : y - 1;
}

export async function ensureLeaveTypes(company, { includeInactive = false } = {}) {
  // Retired types are excluded by default — nobody should be able to file
  // against a policy the company has withdrawn — but HR configuring policy
  // needs to see them, otherwise a deactivated type becomes invisible and can
  // never be brought back.
  const scope = includeInactive ? { company } : { company, active: true };
  const existing = await LeaveType.countDocuments({ company });
  if (existing > 0) return LeaveType.find(scope).sort({ sortOrder: 1 });
  try {
    await LeaveType.insertMany(DEFAULT_LEAVE_TYPES.map((t) => ({ ...t, company })), { ordered: false });
  } catch (err) {
    // A concurrent first request seeded them; the unique index says so.
    if (err.code !== 11000) throw err;
  }
  return LeaveType.find(scope).sort({ sortOrder: 1 });
}

export async function getLeaveType(company, code) {
  const found = await LeaveType.findOne({ company, code, active: true });
  if (found) return found;
  await ensureLeaveTypes(company);
  return LeaveType.findOne({ company, code, active: true });
}

/**
 * Creates the balance row if absent and credits the opening entitlement.
 *
 * Annual-accrual types are credited in full at first touch. Monthly-accrual
 * types start at zero and are topped up by accrueMonthly() — an employee
 * three months into the year has three months of earned leave, not twelve.
 */
export async function ensureBalance({ company, empId, year, type, actor = null }) {
  const existing = await LeaveBalance.findOne({ company, empId, year, type });
  if (existing) return existing;

  const leaveType = await getLeaveType(company, type);
  if (!leaveType) return null;

  const monthsElapsed = new Date().getUTCFullYear() > year ? 12 : new Date().getUTCMonth() + 1;
  const initialAccrual = leaveType.accrualMode === 'monthly'
    ? Math.round((leaveType.annualQuota / 12) * monthsElapsed * 2) / 2 // half-day granularity
    : leaveType.annualQuota;

  try {
    const created = await LeaveBalance.create({
      company, empId, year, type,
      accrued: initialAccrual,
      lastAccruedMonth: leaveType.accrualMode === 'monthly' ? monthsElapsed : 12,
    });
    if (initialAccrual !== 0) {
      await LeaveLedger.create({
        company, empId, year, type,
        delta: initialAccrual,
        bucket: 'accrued',
        reason: leaveType.accrualMode === 'monthly' ? 'monthly-accrual' : 'annual-grant',
        balanceAfter: created.available,
        note: `Opening entitlement for ${year} (${leaveType.accrualMode})`,
        actor: actor || { name: 'System', role: 'System' },
      });
    }
    return created;
  } catch (err) {
    if (err.code === 11000) return LeaveBalance.findOne({ company, empId, year, type });
    throw err;
  }
}

/**
 * Reserves `days` against an employee's balance when a request is FILED.
 *
 * Reserving at filing time (rather than at approval) is what stops an
 * employee filing five overlapping requests for their last three days and
 * having them all approved later.
 *
 * Returns { ok: false, reason: 'INSUFFICIENT_BALANCE', available } when the
 * conditional update matches nothing — which is also exactly what happens
 * when a concurrent request got there first.
 */
export async function reserve({ company, empId, year, type, days, refId, actor, note = '' }) {
  if (!(days > 0)) return { ok: false, reason: 'INVALID_DAYS' };

  const leaveType = await getLeaveType(company, type);
  if (!leaveType) return { ok: false, reason: 'UNKNOWN_LEAVE_TYPE' };

  // Unpaid leave is never limited by a balance — it is limited by approval,
  // and it becomes loss of pay in payroll instead.
  if (!leaveType.paid) {
    return { ok: true, skipped: true, reason: 'UNPAID_LEAVE_NOT_BALANCE_TRACKED', paid: false };
  }

  await ensureBalance({ company, empId, year, type, actor });

  const floor = leaveType.allowNegativeBalance ? -Math.abs(leaveType.negativeBalanceLimit || 0) : 0;

  // One atomic operation: the sufficiency test and the decrement together.
  const updated = await LeaveBalance.findOneAndUpdate(
    {
      company, empId, year, type,
      $expr: {
        $gte: [
          {
            $subtract: [
              { $add: ['$opening', '$accrued', '$adjusted'] },
              { $add: ['$used', '$pending', '$encashed', days] },
            ],
          },
          floor,
        ],
      },
    },
    { $inc: { pending: days } },
    { new: true },
  );

  if (!updated) {
    const current = await LeaveBalance.findOne({ company, empId, year, type });
    return {
      ok: false,
      reason: 'INSUFFICIENT_BALANCE',
      available: current ? current.available : 0,
      requested: days,
    };
  }

  await LeaveLedger.create({
    company, empId, year, type,
    delta: -days, bucket: 'pending', reason: 'leave-applied',
    refType: 'Leave', refId,
    balanceAfter: updated.available,
    note, actor,
  });

  return { ok: true, balance: updated, paid: true };
}

/** Converts a reservation into a consumption when the request is approved. */
export async function commit({ company, empId, year, type, days, refId, actor, note = '' }) {
  const leaveType = await getLeaveType(company, type);
  if (!leaveType || !leaveType.paid) return { ok: true, skipped: true };

  const updated = await LeaveBalance.findOneAndUpdate(
    { company, empId, year, type },
    { $inc: { pending: -days, used: days } },
    { new: true },
  );
  if (!updated) return { ok: false, reason: 'NO_BALANCE_ROW' };

  await LeaveLedger.create({
    company, empId, year, type,
    delta: 0, bucket: 'used', reason: 'leave-approved',
    refType: 'Leave', refId,
    balanceAfter: updated.available,
    note: note || `${days} day(s) approved and consumed`,
    actor,
  });
  return { ok: true, balance: updated };
}

/**
 * Returns a reservation to the employee — declined, withdrawn, or an approved
 * leave cancelled afterwards. `from` says which bucket it comes back out of.
 */
export async function release({ company, empId, year, type, days, refId, actor, from = 'pending', reason = 'leave-withdrawn', note = '' }) {
  const leaveType = await getLeaveType(company, type);
  if (!leaveType || !leaveType.paid) return { ok: true, skipped: true };

  const updated = await LeaveBalance.findOneAndUpdate(
    { company, empId, year, type },
    { $inc: { [from]: -days } },
    { new: true },
  );
  if (!updated) return { ok: false, reason: 'NO_BALANCE_ROW' };

  await LeaveLedger.create({
    company, empId, year, type,
    delta: days, bucket: from, reason,
    refType: 'Leave', refId,
    balanceAfter: updated.available,
    note: note || `${days} day(s) returned to balance`,
    actor,
  });
  return { ok: true, balance: updated };
}

/** Manual HR correction. Always ledgered with the actor who made it. */
export async function adjust({ company, empId, year, type, days, actor, note = '' }) {
  await ensureBalance({ company, empId, year, type, actor });
  const updated = await LeaveBalance.findOneAndUpdate(
    { company, empId, year, type },
    { $inc: { adjusted: days } },
    { new: true },
  );
  if (!updated) return { ok: false, reason: 'NO_BALANCE_ROW' };

  await LeaveLedger.create({
    company, empId, year, type,
    delta: days, bucket: 'adjusted', reason: 'hr-adjustment',
    balanceAfter: updated.available, note, actor,
  });
  return { ok: true, balance: updated };
}

/**
 * Monthly accrual for one employee/type. Idempotent by `lastAccruedMonth`, so
 * running the job twice in a month credits nothing the second time.
 */
export async function accrueMonthly({ company, empId, year, type, month, actor = null }) {
  const leaveType = await getLeaveType(company, type);
  if (!leaveType || leaveType.accrualMode !== 'monthly' || !leaveType.paid) return { ok: true, skipped: true };

  await ensureBalance({ company, empId, year, type, actor });
  const perMonth = Math.round((leaveType.annualQuota / 12) * 2) / 2;
  if (perMonth <= 0) return { ok: true, skipped: true };

  const updated = await LeaveBalance.findOneAndUpdate(
    { company, empId, year, type, lastAccruedMonth: { $lt: month } },
    { $inc: { accrued: perMonth }, $set: { lastAccruedMonth: month } },
    { new: true },
  );
  if (!updated) return { ok: true, skipped: true, reason: 'ALREADY_ACCRUED' };

  await LeaveLedger.create({
    company, empId, year, type,
    delta: perMonth, bucket: 'accrued', reason: 'monthly-accrual',
    balanceAfter: updated.available,
    note: `Accrual for month ${month}/${year}`,
    actor: actor || { name: 'System', role: 'System' },
  });
  return { ok: true, balance: updated };
}

/**
 * Year-end roll: carries forward up to the type's cap and lapses the rest.
 * Both movements are ledgered, so an employee can see exactly how many days
 * lapsed and why.
 */
export async function rollOverYear({ company, empId, fromYear, toYear, actor = null }) {
  const balances = await LeaveBalance.find({ company, empId, year: fromYear });
  const results = [];

  for (const balance of balances) {
    // eslint-disable-next-line no-await-in-loop
    const leaveType = await getLeaveType(company, balance.type);
    if (!leaveType || !leaveType.paid) continue;

    const remaining = Math.max(0, balance.available);
    const carried = leaveType.carryForward
      ? Math.min(remaining, leaveType.carryForwardCap || remaining)
      : 0;
    const lapsed = remaining - carried;

    // eslint-disable-next-line no-await-in-loop
    const next = await ensureBalance({ company, empId, year: toYear, type: balance.type, actor });
    if (!next) continue;

    if (carried > 0) {
      // eslint-disable-next-line no-await-in-loop
      const updated = await LeaveBalance.findOneAndUpdate(
        { _id: next._id },
        { $inc: { opening: carried } },
        { new: true },
      );
      // eslint-disable-next-line no-await-in-loop
      await LeaveLedger.create({
        company, empId, year: toYear, type: balance.type,
        delta: carried, bucket: 'opening', reason: 'carry-forward',
        balanceAfter: updated.available,
        note: `Carried forward from ${fromYear} (cap ${leaveType.carryForwardCap || 'none'})`,
        actor: actor || { name: 'System', role: 'System' },
      });
    }

    if (lapsed > 0) {
      // eslint-disable-next-line no-await-in-loop
      await LeaveLedger.create({
        company, empId, year: fromYear, type: balance.type,
        delta: -lapsed, bucket: 'adjusted', reason: 'year-end-lapse',
        balanceAfter: 0,
        note: leaveType.carryForward
          ? `${lapsed} day(s) above the ${leaveType.carryForwardCap}-day carry-forward cap lapsed`
          : `${lapsed} day(s) lapsed — this type does not carry forward`,
        actor: actor || { name: 'System', role: 'System' },
      });
    }

    results.push({ type: balance.type, carried, lapsed });
  }

  return results;
}

/**
 * Full balance sheet for one employee/leave year, used by the API and the UI.
 *
 * Materialises any missing balance row first. Without that, a monthly-accrual
 * type reported `available: 0` until the employee happened to file something —
 * so somebody nine months into the year who had never taken leave was shown
 * zero earned leave rather than the nine months they had accrued, and would
 * reasonably conclude they had none to take.
 */
export async function balanceSheet({ company, empId, year }) {
  const types = await ensureLeaveTypes(company);
  for (const type of types) {
    if (!type.paid) continue; // unpaid leave is not balance-tracked
    // eslint-disable-next-line no-await-in-loop
    await ensureBalance({ company, empId, year, type: type.code });
  }
  const balances = await LeaveBalance.find({ company, empId, year });
  const byType = new Map(balances.map((b) => [b.type, b]));

  return types.map((t) => {
    const b = byType.get(t.code);
    return {
      type: t.code,
      name: t.name,
      paid: t.paid,
      annualQuota: t.annualQuota,
      accrualMode: t.accrualMode,
      opening: b?.opening || 0,
      accrued: b?.accrued || 0,
      adjusted: b?.adjusted || 0,
      used: b?.used || 0,
      pending: b?.pending || 0,
      encashed: b?.encashed || 0,
      available: b ? b.available : (t.accrualMode === 'annual' ? t.annualQuota : 0),
      // Unpaid leave deliberately reports no balance rather than 0 — it is not
      // balance-tracked at all, and showing "0 available" would read as
      // "cannot apply".
      balanceTracked: t.paid,
    };
  });
}

/**
 * Recomputes a balance from its ledger. The reconciliation check — if this
 * ever disagrees with the stored balance, something wrote around this module.
 */
export async function reconcile({ company, empId, year, type }) {
  const entries = await LeaveLedger.find({ company, empId, year, type }).sort({ createdAt: 1 });
  const totals = { opening: 0, accrued: 0, adjusted: 0, used: 0, pending: 0, encashed: 0 };
  for (const e of entries) {
    if (e.bucket === 'used' && e.reason === 'leave-approved') continue; // net-zero move
    totals[e.bucket] = (totals[e.bucket] || 0) + (e.bucket === 'pending' || e.bucket === 'used' ? -e.delta : e.delta);
  }
  const stored = await LeaveBalance.findOne({ company, empId, year, type });
  const computedAvailable = totals.opening + totals.accrued + totals.adjusted - totals.used - totals.pending - totals.encashed;
  const matches = stored ? Math.abs(stored.available - computedAvailable) < 0.001 : computedAvailable === 0;
  if (!matches) {
    logger.warn('[leaveLedger] balance drift for %s/%s/%s/%s: stored=%s ledger=%s',
      company, empId, year, type, stored?.available, computedAvailable);
  }
  return { matches, stored: stored ? stored.available : null, fromLedger: computedAvailable, entries: entries.length };
}
