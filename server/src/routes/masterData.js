import { Router } from 'express';
import MasterCategory from '../models/MasterCategory.js';
import MasterValue from '../models/MasterValue.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';
import { getCache, setCache, invalidateCache } from '../lib/cacheStore.js';

const router = Router();
router.use(requireAuth);

router.get('/master-categories', async (_req, res) => {
  const categories = await MasterCategory.find().sort({ name: 1 });
  res.json(categories);
});

router.get('/master-values', async (req, res) => {
  const isTest = process.env.NODE_ENV === 'test';
  const company = req.auth.company;
  const cacheKey = `masterValues:${company}`;
  const cached = !isTest && getCache(cacheKey);
  if (cached) return res.json(cached);

  const values = await MasterValue.find(companyFilter(req)).sort({ value: 1 });
  if (!isTest) setCache(cacheKey, values, 10 * 60 * 1000);
  res.json(values);
});

router.post('/master-categories', requireRole('HR Director'), async (req, res) => {
  try {
    const created = await MasterCategory.create(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.post('/master-values', requireRole('HR Director'), async (req, res) => {
  try {
    const body = { ...(req.body || {}), company: req.auth.company };
    const created = await MasterValue.create(body);
    invalidateCache(`masterValues:${req.auth.company}`);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.patch('/master-values/:id', requireRole('HR Director'), async (req, res) => {
  try {
    const updated = await MasterValue.findOneAndUpdate(
      { _id: req.params.id, ...companyFilter(req) },
      req.body || {},
      { new: true },
    );
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Value not found.' } });
    invalidateCache(`masterValues:${req.auth.company}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.delete('/master-values/:id', requireRole('HR Director'), async (req, res) => {
  try {
    await MasterValue.findOneAndDelete({ _id: req.params.id, ...companyFilter(req) });
    invalidateCache(`masterValues:${req.auth.company}`);
    res.json({ id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

export default router;
