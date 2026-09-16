// Server-side reporting.
//
// WHY THIS EXISTS: every figure on the Analytics page used to be computed in
// the browser from whatever the app shell happened to have hydrated — and
// GET /attendance caps an unpaged response at the 100 most recent rows. So the
// "attendance rate" a company of 100 people saw was derived from roughly ONE
// day of data, the department breakdown was derived from the same 100 rows,
// and the payroll total covered only the payslips the client had loaded. The
// numbers were confidently wrong, and grew more wrong as the company grew.
//
// These endpoints aggregate in MongoDB over the FULL collection, scoped to the
// caller's company and an explicit date range, and return only the rolled-up
// figures — so the payload stays small no matter how large the tenant is.
import { Router } from 'express';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import Leave from '../models/Leave.js';
import Payroll from '../models/Payroll.js';
import Candidate from '../models/Candidate.js';
import LifecycleEvent from '../models/LifecycleEvent.js';
import Resignation from '../models/Resignation.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Reporting spans the whole company, so it is HR/Finance only. An individual's
// own figures are available from their own module endpoints.
const REPORT_ROLES = ['HR Manager', 'Finance Lead', 'manageEmployees', 'managePayroll'];

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Defaults to the current month when the caller gives no range. */
function resolveRange(query) {
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 10);
  const from = ISO_DATE.test(String(query.from || '')) ? String(query.from) : firstOfMonth;
  const to = ISO_DATE.test(String(query.to || '')) ? String(query.to) : now.toISOString().slice(0, 10);
  // A reversed range would silently return nothing, which reads as "no data"
  // rather than "you asked for an impossible window".
  return from <= to ? { from, to } : { from: to, to: from };
}

const PRESENT_STATUSES = ['present', 'late'];

/**
 * GET /analytics/overview
 *
 * Headline figures plus a per-department breakdown, for a date range.
 * Query: from, to (YYYY-MM-DD), dept (optional).
 */
router.get('/overview', requireRole(...REPORT_ROLES), async (req, res) => {
  const company = req.auth.company;
  const { from, to } = resolveRange(req.query);
  const dept = req.query.dept && req.query.dept !== 'All' ? String(req.query.dept) : null;

  const employeeScope = { ...companyFilter(req), ...(dept ? { dept } : {}) };

  // The employee ids in scope are needed to keep the attendance/leave/payroll
  // aggregations inside the department filter. Ids only — not whole documents.
  const scopedEmployees = await Employee.find(employeeScope, { _id: 1, dept: 1, status: 1 }).lean();
  const scopedIds = scopedEmployees.map((e) => e._id);

  const [attendanceByStatus, leaveByStatus, payrollTotals, byDepartment] = await Promise.all([
    Attendance.aggregate([
      { $match: { company, date: { $gte: from, $lte: to }, ...(dept ? { empId: { $in: scopedIds } } : {}) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Leave.aggregate([
      { $match: { company, start: { $lte: to }, end: { $gte: from }, ...(dept ? { empId: { $in: scopedIds } } : {}) } },
      { $group: { _id: '$status', count: { $sum: 1 }, days: { $sum: '$workingDays' } } },
    ]),
    Payroll.aggregate([
      {
        $match: {
          company,
          cycle: { $gte: from.slice(0, 7), $lte: to.slice(0, 7) },
          ...(dept ? { empId: { $in: scopedIds } } : {}),
        },
      },
      {
        $group: {
          _id: null,
          gross: { $sum: '$gross' },
          deductions: { $sum: '$deductions' },
          net: { $sum: '$net' },
          payslips: { $sum: 1 },
          paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
        },
      },
    ]),
    // One pipeline for the whole department table, rather than one query per
    // department in a loop.
    Attendance.aggregate([
      { $match: { company, date: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$dept',
          total: { $sum: 1 },
          present: { $sum: { $cond: [{ $in: ['$status', PRESENT_STATUSES] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
          onLeave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const statusCounts = Object.fromEntries(attendanceByStatus.map((r) => [r._id, r.count]));
  const totalMarked = attendanceByStatus.reduce((sum, r) => sum + r.count, 0);
  const presentCount = PRESENT_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

  const headcountByDept = new Map();
  for (const emp of scopedEmployees) {
    headcountByDept.set(emp.dept, (headcountByDept.get(emp.dept) || 0) + 1);
  }

  const money = payrollTotals[0] || { gross: 0, deductions: 0, net: 0, payslips: 0, paid: 0 };

  res.json({
    range: { from, to },
    dept: dept || 'All',
    headcount: {
      total: scopedEmployees.length,
      active: scopedEmployees.filter((e) => e.status === 'active').length,
      exited: scopedEmployees.filter((e) => e.status === 'exited').length,
    },
    attendance: {
      marked: totalMarked,
      present: presentCount,
      late: statusCounts.late || 0,
      absent: statusCounts.absent || 0,
      onLeave: statusCounts.leave || 0,
      halfDay: statusCounts['half-day'] || 0,
      // Null rather than 0 when nothing is marked: "no data" and "nobody came
      // in" are different answers and must not look the same.
      ratePct: totalMarked ? Math.round((presentCount / totalMarked) * 1000) / 10 : null,
    },
    leave: {
      pending: leaveByStatus.find((r) => r._id === 'pending')?.count || 0,
      approved: leaveByStatus.find((r) => r._id === 'approved')?.count || 0,
      declined: leaveByStatus.find((r) => r._id === 'declined')?.count || 0,
      withdrawn: leaveByStatus.find((r) => r._id === 'withdrawn')?.count || 0,
      approvedDays: leaveByStatus.find((r) => r._id === 'approved')?.days || 0,
    },
    payroll: {
      gross: money.gross,
      deductions: money.deductions,
      net: money.net,
      payslips: money.payslips,
      paid: money.paid,
    },
    departments: byDepartment.map((d) => ({
      dept: d._id || 'Unassigned',
      headcount: headcountByDept.get(d._id) || 0,
      marked: d.total,
      present: d.present,
      late: d.late,
      absent: d.absent,
      onLeave: d.onLeave,
      ratePct: d.total ? Math.round((d.present / d.total) * 1000) / 10 : null,
    })),
  });
});

/**
 * GET /analytics/attendance-trend
 *
 * Day-by-day attendance across the range, for the chart — aggregated rather
 * than shipping every row to the browser to be counted there.
 */
router.get('/attendance-trend', requireRole(...REPORT_ROLES), async (req, res) => {
  const company = req.auth.company;
  const { from, to } = resolveRange(req.query);

  const rows = await Attendance.aggregate([
    { $match: { company, date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$date',
        present: { $sum: { $cond: [{ $in: ['$status', PRESENT_STATUSES] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
        onLeave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
        marked: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    // A range is operator-chosen; this stops a five-year window from returning
    // an unbounded series.
    { $limit: 400 },
  ]);

  res.json({
    range: { from, to },
    days: rows.map((r) => ({
      date: r._id,
      marked: r.marked,
      present: r.present,
      absent: r.absent,
      onLeave: r.onLeave,
      ratePct: r.marked ? Math.round((r.present / r.marked) * 1000) / 10 : null,
    })),
  });
});


/**
 * GET /analytics/workforce
 *
 * Hiring and attrition for a window: who joined, who left, what that is as a
 * rate, and where the candidate pipeline stands.
 *
 * Attrition is expressed against the AVERAGE headcount over the window (the
 * usual definition), and the inputs are returned alongside it — a bare
 * percentage with no denominator is not a number anyone can check.
 */
router.get('/workforce', requireRole(...REPORT_ROLES), async (req, res) => {
  const company = req.auth.company;
  const { from, to } = resolveRange(req.query);

  const [joined, exitEvents, currentHeadcount, pipeline, offers, openExits] = await Promise.all([
    Employee.find(
      { company, joinDate: { $gte: from, $lte: to } },
      { name: 1, dept: 1, role: 1, joinDate: 1 },
    ).sort({ joinDate: 1 }).limit(500).lean(),

    LifecycleEvent.find(
      { company, type: 'exited', effectiveDate: { $gte: from, $lte: to } },
      { employeeName: 1, effectiveDate: 1, empId: 1 },
    ).lean(),

    Employee.countDocuments({ company, status: { $ne: 'exited' } }),

    Candidate.aggregate([
      { $match: { company } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]),

    Candidate.aggregate([
      { $match: { company, 'offer.status': { $ne: 'draft' } } },
      { $group: { _id: '$offer.status', count: { $sum: 1 } } },
    ]),

    Resignation.countDocuments({ company, status: { $in: ['Submitted', 'Approved'] } }),
  ]);

  // An exit is recorded as a lifecycle event, but employees who left before
  // that existed only carry status 'exited' — so both are counted, without
  // double-counting anyone.
  const exitedIds = new Set(exitEvents.map((e) => String(e.empId)));
  const legacyExits = await Employee.countDocuments({
    company,
    status: 'exited',
    _id: { $nin: [...exitedIds].map((id) => id) },
    updatedAt: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) },
  });

  const exits = exitEvents.length + legacyExits;
  const joins = joined.length;

  // Average headcount over the window, from where it ended and what moved.
  const openingHeadcount = currentHeadcount - joins + exits;
  const averageHeadcount = (openingHeadcount + currentHeadcount) / 2;

  const byStage = Object.fromEntries(pipeline.map((p) => [p._id, p.count]));
  const byOfferStatus = Object.fromEntries(offers.map((o) => [o._id, o.count]));
  const offersSent = (byOfferStatus.sent || 0) + (byOfferStatus.accepted || 0) + (byOfferStatus.declined || 0);

  res.json({
    range: { from, to },
    headcount: {
      opening: openingHeadcount,
      closing: currentHeadcount,
      average: Math.round(averageHeadcount * 10) / 10,
    },
    hiring: {
      joined: joins,
      joiners: joined.map((e) => ({
        id: String(e._id), name: e.name, dept: e.dept, role: e.role, joinDate: e.joinDate,
      })),
      pipeline: byStage,
      offersSent,
      offersAccepted: byOfferStatus.accepted || 0,
      offersDeclined: byOfferStatus.declined || 0,
      // Null rather than 0 when no offer has been answered — an acceptance
      // rate of "0%" would be a false statement about a company that has not
      // made an offer yet.
      offerAcceptanceRatePct: (byOfferStatus.accepted || 0) + (byOfferStatus.declined || 0) > 0
        ? Math.round(((byOfferStatus.accepted || 0)
          / ((byOfferStatus.accepted || 0) + (byOfferStatus.declined || 0))) * 1000) / 10
        : null,
    },
    attrition: {
      exits,
      exitsRecorded: exitEvents.map((e) => ({ name: e.employeeName, date: e.effectiveDate })),
      inNoticePeriod: openExits,
      // The denominator is returned above, so this figure can be checked
      // rather than taken on trust.
      ratePct: averageHeadcount > 0
        ? Math.round((exits / averageHeadcount) * 1000) / 10
        : null,
    },
  });
});

export default router;
