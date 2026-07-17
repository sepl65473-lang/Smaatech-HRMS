import { Router } from 'express';
import Review from '../models/Review.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  const rows = await Review.find(isManager ? {} : { empId: req.auth.employeeId }).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await Review.findById(req.params.id);
  res.json(row || null);
});

// startReviewCycle calls this once per employee (no bulk endpoint needed).
router.post('/', requireRole('HR Manager'), async (req, res) => {
  const created = await Review.create(req.body || {});
  res.status(201).json(created);
});

// Dual path: HR Manager/Director can edit anything (manager rating, goals,
// starting a cycle's fields, etc). An Employee may only patch their own
// review, and only its self-review fields — submitSelfReview from /ess.
const SELF_REVIEW_KEYS = ['selfRating', 'selfComments', 'status'];

router.patch('/:id', async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found.' } });

  const isManager = req.auth.role === 'HR Director' || req.auth.role === 'HR Manager';
  if (!isManager) {
    const isSelf = req.auth.employeeId && String(review.empId) === String(req.auth.employeeId);
    const bodyKeys = Object.keys(req.body || {});
    if (!isSelf || bodyKeys.some((k) => !SELF_REVIEW_KEYS.includes(k))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' } });
    }
  }

  Object.assign(review, req.body || {});
  await review.save();
  res.json(review);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Review.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id });
});

export default router;
