// PERFORMANCE REVIEWS.
//
// Two defects shaped this rewrite.
//
// 1. THE RATINGS WERE BEING THROWN AWAY. The PATCH allow-list named fields the
//    schema does not have — `selfReview`, `managerReview`, `rating` — while the
//    document stores `selfRating`, `selfComments`, `managerRating`,
//    `managerComments`. pickFields() therefore stripped every rating and
//    comment anybody typed, only `status` and `goals` survived, and the UI
//    reported success. A completed appraisal cycle left no appraisal behind.
//
// 2. THE REPORTING MANAGER COULD NOT REVIEW. Only HR could write a manager
//    review, which is the one thing the module exists to do. A manager review
//    is now written by the employee's actual manager (Employee.managerId),
//    with HR as the escalation path — the same organisational rule leave
//    approval already uses.
//
// Reading was also unauthorized: GET /:id returned any review to any signed-in
// user, so one employee could read another's ratings and comments by id.
import { Router } from 'express';
import mongoose from 'mongoose';
import Review from '../models/Review.js';
import Employee from '../models/Employee.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLogger.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['HR Director', 'HR Manager'];
const isHR = (req) => HR_ROLES.includes(req.auth.role);

// What each party may write, matched to the ACTUAL schema.
const SELF_FIELDS = ['selfRating', 'selfComments'];
const MANAGER_FIELDS = ['managerRating', 'managerComments', 'goals'];
const HR_FIELDS = [...SELF_FIELDS, ...MANAGER_FIELDS, 'cycleName'];

const RATING_FIELDS = ['selfRating', 'managerRating'];
const VALID_STATUSES = ['pending', 'self-submitted', 'completed'];

function pick(body, fields) {
  const out = {};
  for (const field of fields) {
    if (body?.[field] !== undefined) out[field] = body[field];
  }
  return out;
}

/** Ratings are a 1–5 scale; anything else is a mistake, not a review. */
function validateRatings(patch) {
  for (const field of RATING_FIELDS) {
    if (patch[field] === undefined || patch[field] === null) continue;
    const value = Number(patch[field]);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      return `${field} must be a whole number between 1 and 5.`;
    }
    patch[field] = Math.round(value);
  }
  if (patch.selfComments !== undefined) patch.selfComments = String(patch.selfComments).slice(0, 5000);
  if (patch.managerComments !== undefined) patch.managerComments = String(patch.managerComments).slice(0, 5000);
  return null;
}

async function managesEmployee(req, empId) {
  if (!req.auth.employeeId) return false;
  const target = await Employee.findOne({ _id: empId, ...companyFilter(req) }, { managerId: 1 }).lean();
  return Boolean(target?.managerId && String(target.managerId) === String(req.auth.employeeId));
}

/** The ids whose reviews this caller may see: their own, plus their team. */
async function visibleEmployeeIds(req) {
  const ids = [];
  if (req.auth.employeeId) {
    ids.push(req.auth.employeeId);
    const reports = await Employee.find(
      { ...companyFilter(req), managerId: req.auth.employeeId }, { _id: 1 },
    ).lean();
    ids.push(...reports.map((r) => r._id));
  }
  return ids;
}

router.get('/', async (req, res) => {
  const scope = { ...companyFilter(req) };
  if (!isHR(req)) {
    const ids = await visibleEmployeeIds(req);
    if (!ids.length) return res.json([]);
    scope.empId = { $in: ids };
  }
  if (req.query.cycleName) scope.cycleName = String(req.query.cycleName);

  const rows = await Review.find(scope).sort({ createdAt: -1 }).limit(500);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });
  }
  const row = await Review.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });

  // A review holds someone's ratings and their manager's written opinion of
  // them. Previously any authenticated user could read anyone's by id.
  if (!isHR(req)) {
    const isOwn = req.auth.employeeId && String(row.empId) === String(req.auth.employeeId);
    if (!isOwn && !(await managesEmployee(req, row.empId))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot read this review.' } });
    }
  }
  res.json(row);
});

// One review per employee per cycle. startReviewCycle() calls this once per
// employee, and a retried or double-clicked cycle start must not produce two.
router.post('/', requireRole('HR Manager'), async (req, res) => {
  const { cycleName, empId } = req.body || {};
  if (!String(cycleName || '').trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'cycleName is required.' } });
  }
  if (!empId || !mongoose.Types.ObjectId.isValid(String(empId))) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'empId is not a valid id.' } });
  }

  const employee = await Employee.findOne({ _id: empId, ...companyFilter(req) });
  if (!employee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Employee not found.' } });

  try {
    // Ratings and status are never accepted at creation: a review starts empty
    // and is filled in by the people doing it.
    const created = await Review.create({
      cycleName: String(cycleName).slice(0, 120),
      empId: employee._id,
      name: employee.name,
      dept: employee.dept,
      company: req.auth.company,
      status: 'pending',
      selfRating: null,
      selfComments: '',
      managerRating: null,
      managerComments: '',
      goals: [],
    });
    return res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) {
      const existing = await Review.findOne({ company: req.auth.company, cycleName, empId });
      return res.status(409).json({
        error: {
          code: 'REVIEW_EXISTS',
          message: `${employee.name} already has a review for ${cycleName}.`,
          existingId: existing ? String(existing._id) : null,
        },
      });
    }
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });
  }
  const review = await Review.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!review) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });

  const isOwn = req.auth.employeeId && String(review.empId) === String(req.auth.employeeId);
  const hr = isHR(req);
  // Nobody is their own reviewing manager, whatever the org chart says.
  const isTheirManager = !isOwn && await managesEmployee(req, review.empId);

  const wantsSelf = SELF_FIELDS.some((f) => req.body?.[f] !== undefined);
  const wantsManager = MANAGER_FIELDS.some((f) => req.body?.[f] !== undefined);

  let patch;
  let action;

  if (hr) {
    patch = pick(req.body, HR_FIELDS);
    action = wantsManager ? 'Manager review submitted' : 'Review updated';
  } else if (isOwn && !wantsManager) {
    // An employee writes their own self review — and only that.
    patch = pick(req.body, SELF_FIELDS);
    action = 'Self review submitted';
  } else if (isTheirManager && !wantsSelf) {
    patch = pick(req.body, MANAGER_FIELDS);
    action = 'Manager review submitted';
  } else {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'You do not have permission to write this part of the review.' },
    });
  }

  const problem = validateRatings(patch);
  if (problem) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: problem } });

  // Status follows from what was actually submitted, rather than being taken
  // from the request — which is how an employee could mark their own review
  // 'completed' before anyone had reviewed it.
  if (req.body?.status !== undefined) {
    const requested = String(req.body.status);
    if (!VALID_STATUSES.includes(requested)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${VALID_STATUSES.join(', ')}.` } });
    }
    if (requested === 'completed' && !hr && !isTheirManager) {
      return res.status(400).json({
        error: { code: 'FORBIDDEN_STATUS', message: 'Only the reporting manager or HR can complete a review.' },
      });
    }
    patch.status = requested;
  } else if (wantsManager && (hr || isTheirManager)) {
    patch.status = 'completed';
  } else if (wantsSelf && isOwn) {
    patch.status = 'self-submitted';
  }

  const before = review.toJSON();
  Object.assign(review, patch);
  await review.save();

  // The appraisal rating belongs on the employee record too (the directory and
  // reports read it from there). The CLIENT used to do this with a second call
  // to PATCH /employees/:id — a field only HR may write, so a reporting manager
  // completing a review got a 403 on the follow-up and the rating never landed.
  // It is applied here, by the same authority that accepted the review.
  if (patch.managerRating !== undefined && patch.managerRating !== null) {
    await Employee.updateOne(
      { _id: review.empId, ...companyFilter(req) },
      { rating: patch.managerRating },
    );
  }

  await logAudit(req, {
    action,
    subject: review.name,
    before,
    after: review,
    details: review.cycleName,
  });

  res.json(review);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  const deleted = await Review.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });
  await logAudit(req, { action: 'Review deleted', subject: deleted.name, before: deleted });
  res.json({ id: req.params.id });
});

export default router;
