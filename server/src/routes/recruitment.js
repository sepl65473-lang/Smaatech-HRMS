import { Router } from 'express';
import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import LifecycleEvent from '../models/LifecycleEvent.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { pickFields } from '../lib/patchGuard.js';
import { logAudit } from '../lib/auditLogger.js';
import { runInTransaction } from '../lib/transactionHelper.js';
import { employmentPolicy, addMonths } from './lifecycle.js';
import { todayISO } from '../lib/dateUtils.js';

const CANDIDATE_PATCH_FIELDS = [
  'title', 'candidate', 'stage', 'meta', 'onboarding',
  'email', 'phone', 'dept', 'loc', 'employmentType',
];

// The offer and the employee link are deliberately NOT patchable: they are
// changed only by the offer/hire endpoints below, which validate the
// transition and record it. Leaving them in the generic merge-patch would let
// a client set "offer accepted" or point a candidate at someone else's
// employee record with an ordinary PATCH.

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const router = Router();
router.use(requireAuth);

// Candidate records hold applicant contact details, CVs and interview notes —
// personal data about people who do not work here and never consented to the
// whole company reading it. Previously every authenticated employee could.
//
// Non-HR callers get an EMPTY LIST rather than a 403. That is not a softening
// of the rule — no candidate data is returned either way — it is what the
// client contract requires: loadAll() in client/src/data/store.js fetches this
// collection inside a Promise.all with no per-call catch, so a 403 here made
// the entire app fail to load for every Employee and Finance Lead. Returning
// [] matches how resignations, expenses and attendance-corrections already
// scope themselves for users who may see nothing.
function canSeeCandidates(req) {
  return ['HR Director', 'HR Manager'].includes(req.auth.role);
}

router.get('/', async (req, res) => {
  if (!canSeeCandidates(req)) return res.json([]);
  const rows = await Candidate.find(companyFilter(req)).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  // A direct fetch by id is a deliberate act, not app bootstrap, so this one
  // does refuse rather than pretending the record is absent.
  if (!canSeeCandidates(req)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only HR can view candidate records.' } });
  }
  const row = await Candidate.findOne({ _id: req.params.id, ...companyFilter(req) });
  res.json(row || null);
});

router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Candidate.create({ stage: 'Applied', meta: 'just now', ...req.body, company: req.auth.company });
  res.status(201).json(created);
});

// Generic merge-patch — moveCandidate sends { stage, ...extra } (e.g. meta
// alongside a stage change, and onboarding wholesale on first hire),
// toggleOnboardingItem sends a full replacement `onboarding` array.

/**
 * OFFER MANAGEMENT AND HIRING.
 *
 * Recruitment previously ended at a "Hired" column. Nothing turned a hired
 * candidate into an employee, so somebody re-typed the details into the
 * employee form and the link between the applicant and the person was lost —
 * along with what they had actually been offered.
 */

/** Extends or revises an offer. */
router.post('/:id/offer', requireRole('HR Manager'), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  }
  const candidate = await Candidate.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!candidate) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });

  if (candidate.employeeId) {
    return res.status(409).json({
      error: { code: 'ALREADY_HIRED', message: `${candidate.candidate} has already been hired.` },
    });
  }
  if (candidate.offer?.status === 'accepted') {
    return res.status(409).json({
      error: { code: 'OFFER_ALREADY_ACCEPTED', message: 'This offer has already been accepted. Withdraw it before issuing a new one.' },
    });
  }

  const salary = Number(req.body?.salary);
  if (!Number.isFinite(salary) || salary <= 0 || salary > 1e9) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'salary must be a number between 1 and 1,000,000,000.' } });
  }
  const joiningDate = String(req.body?.joiningDate || '');
  if (!ISO_DATE.test(joiningDate)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'joiningDate must be a YYYY-MM-DD date.' } });
  }
  let basic = null;
  if (req.body?.basic !== undefined && req.body.basic !== null && req.body.basic !== '') {
    basic = Number(req.body.basic);
    if (!Number.isFinite(basic) || basic < 0 || basic > salary) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'basic must be between 0 and the offered salary.' } });
    }
  }

  candidate.offer = {
    salary,
    basic,
    joiningDate,
    status: 'sent',
    sentAt: new Date(),
    respondedAt: null,
    note: String(req.body?.note || '').slice(0, 500),
    declineReason: '',
  };
  // An offer out means the candidate is at the Offer stage, whatever column
  // they were dragged to.
  if (candidate.stage !== 'Offer') candidate.stage = 'Offer';
  await candidate.save();

  await logAudit(req, {
    action: 'Offer issued',
    subject: candidate.candidate,
    after: candidate.offer,
    details: `${salary} joining ${joiningDate}`,
  });

  res.status(201).json(candidate);
});

/** Records what the candidate said. */
router.post('/:id/offer/response', requireRole('HR Manager'), async (req, res) => {
  const decision = String(req.body?.decision || '');
  if (!['accepted', 'declined'].includes(decision)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: "decision must be 'accepted' or 'declined'." } });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  }

  const candidate = await Candidate.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!candidate) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  if (candidate.offer?.status !== 'sent') {
    return res.status(409).json({
      error: { code: 'NO_OPEN_OFFER', message: `There is no offer awaiting a response for ${candidate.candidate}.` },
    });
  }
  if (decision === 'declined' && !String(req.body?.reason || '').trim()) {
    return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: 'A reason is required when an offer is declined.' } });
  }

  candidate.offer.status = decision;
  candidate.offer.respondedAt = new Date();
  if (decision === 'declined') candidate.offer.declineReason = String(req.body.reason).slice(0, 500);
  await candidate.save();

  await logAudit(req, { action: `Offer ${decision}`, subject: candidate.candidate, after: candidate.offer });
  res.json(candidate);
});

/**
 * Turns an accepted candidate into an employee.
 *
 * Idempotent: the candidate carries the employee id it created, so a retry or
 * a double-click returns the same person rather than hiring them twice.
 */
router.post('/:id/hire', requireRole('HR Manager'), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  }
  const candidate = await Candidate.findOne({ _id: req.params.id, ...companyFilter(req) });
  if (!candidate) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });

  if (candidate.employeeId) {
    const existing = await Employee.findOne({ _id: candidate.employeeId, ...companyFilter(req) });
    if (existing) {
      res.setHeader('X-Idempotent-Replay', 'true');
      return res.status(200).json({ candidate, employee: existing, alreadyHired: true });
    }
  }

  if (candidate.offer?.status !== 'accepted') {
    return res.status(409).json({
      error: {
        code: 'OFFER_NOT_ACCEPTED',
        message: 'An employee record can only be created once the offer has been accepted.',
      },
    });
  }
  if (!candidate.email) {
    return res.status(400).json({
      error: { code: 'EMAIL_REQUIRED', message: 'The candidate needs a work email before they can be hired.' },
    });
  }

  const policy = await employmentPolicy(req.auth.company);
  const joinDate = candidate.offer.joiningDate || todayISO();

  let employee;
  try {
    await runInTransaction(async (session) => {
      const opts = session ? { session } : {};
      const [created] = await Employee.create([{
        name: candidate.candidate,
        role: candidate.title,
        dept: candidate.dept || '',
        loc: candidate.loc || '',
        email: candidate.email,
        phone: candidate.phone || '',
        employmentType: candidate.employmentType || 'Full-time',
        joinDate,
        salary: candidate.offer.salary,
        basic: candidate.offer.basic ?? null,
        status: 'active',
        employmentStage: 'Probation',
        probationEndDate: policy.probationMonths > 0 ? addMonths(joinDate, policy.probationMonths) : '',
        company: req.auth.company,
      }], opts);
      employee = created;

      await Candidate.updateOne(
        { _id: candidate._id, company: req.auth.company },
        { employeeId: created._id, stage: 'Hired' },
        opts,
      );
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: {
          code: 'EMAIL_IN_USE',
          message: `An employee already exists with the email ${candidate.email}.`,
        },
      });
    }
    throw err;
  }

  // The start of employment is recorded like every other lifecycle change.
  await LifecycleEvent.create({
    company: req.auth.company,
    empId: employee._id,
    employeeName: employee.name,
    type: 'probation-started',
    effectiveDate: joinDate,
    changes: {
      employmentStage: { from: null, to: 'Probation' },
      probationEndDate: { from: null, to: employee.probationEndDate },
    },
    note: `Hired from recruitment · offer accepted ${candidate.offer.respondedAt ? new Date(candidate.offer.respondedAt).toISOString().slice(0, 10) : ''}`.trim(),
    dedupeKey: `probation-start:${employee._id}`,
    actor: { id: req.auth.sub, name: req.auth.name, role: req.auth.role },
  }).catch(() => { /* the hire must not fail over its own history row */ });

  await logAudit(req, {
    action: 'Candidate hired',
    subject: candidate.candidate,
    after: employee,
    details: `joining ${joinDate} at ${candidate.offer.salary}`,
  });

  const updated = await Candidate.findById(candidate._id);
  res.status(201).json({ candidate: updated, employee, alreadyHired: false });
});

router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Candidate.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    pickFields(req.body, CANDIDATE_PATCH_FIELDS),
    { new: true },
  );
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Candidate.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  res.json({ id: req.params.id });
});

export default router;
