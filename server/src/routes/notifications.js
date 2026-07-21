import { Router } from 'express';
import Notification from '../models/Notification.js';
import { requireAuth, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const userId = req.auth.id;
    // Fetch user targeted notifications + global notifications, scoped to company
    const rows = await Notification.find({
      ...companyFilter(req),
      $or: [
        { recipientId: userId },
        { recipientId: null },
      ],
    }).sort({ createdAt: -1 }).limit(100);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    const updated = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...companyFilter(req), $or: [{ recipientId: req.auth.id }, { recipientId: null }] },
      { read: true },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.patch('/read-all', async (req, res) => {
  try {
    const userId = req.auth.id;
    await Notification.updateMany(
      { recipientId: userId, read: false },
      { read: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Notification.findOneAndDelete({
      _id: req.params.id,
      ...companyFilter(req),
      $or: [{ recipientId: req.auth.id }, { recipientId: null }],
    });
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    res.json({ id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

export default router;
