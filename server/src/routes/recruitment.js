import { Router } from 'express';
import Candidate from '../models/Candidate.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const rows = await Candidate.find(companyFilter(req)).sort({ createdAt: -1 });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
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
router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const updated = await Candidate.findOneAndUpdate({ _id: req.params.id, ...companyFilter(req) }, req.body || {}, { new: true });
  if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } });
  res.json(updated);
});

router.delete('/:id', requireRole('HR Manager'), async (req, res) => {
  await Candidate.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
  res.json({ id: req.params.id });
});

export default router;
