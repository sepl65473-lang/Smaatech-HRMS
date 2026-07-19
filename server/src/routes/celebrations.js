import { Router } from 'express';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Wish from '../models/Wish.js';
import { requireAuth, requireRole, companyFilter } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const WINDOW_DAYS = 14;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Finds the next upcoming month/day occurrence of a 'YYYY-MM-DD' string
// relative to today, rolling into next year if this year's date has passed.
// Built from local-timezone date parts throughout to avoid UTC-parsing
// off-by-one issues near midnight.
function nextOccurrence(dateStr, today) {
  const parts = String(dateStr).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [origYear, month, day] = parts;
  let year = today.getFullYear();
  let occurrence = new Date(year, month - 1, day);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (occurrence < todayMidnight) {
    year += 1;
    occurrence = new Date(year, month - 1, day);
  }
  const diffDays = Math.round((occurrence - todayMidnight) / 86400000);
  return { diffDays, year, occurrence, origYear };
}

function relativeDayText(diffDays, occurrence) {
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 6) return WEEKDAY[occurrence.getDay()];
  return `${MONTH[occurrence.getMonth()]} ${occurrence.getDate()}`;
}

// Computed from real Employee data (dob + joinDate) rather than stored —
// only the "already wished" acknowledgment is persisted, in Wish.
router.get('/', async (req, res) => {
  const employees = await Employee.find({
    ...companyFilter(req),
    $or: [{ dob: { $nin: [null, ''] } }, { joinDate: { $nin: [null, ''] } }],
  });
  const today = new Date();

  const raw = [];
  for (const emp of employees) {
    if (emp.dob) {
      const occ = nextOccurrence(emp.dob, today);
      if (occ && occ.diffDays <= WINDOW_DAYS) {
        raw.push({
          empId: emp.id, type: 'birthday', year: occ.year, name: emp.name, diffDays: occ.diffDays,
          detail: `Birthday · ${relativeDayText(occ.diffDays, occ.occurrence)}`,
        });
      }
    }
    if (emp.joinDate) {
      const occ = nextOccurrence(emp.joinDate, today);
      const years = occ ? occ.year - occ.origYear : 0;
      if (occ && occ.diffDays <= WINDOW_DAYS && years > 0) {
        raw.push({
          empId: emp.id, type: 'anniv', year: occ.year, name: emp.name, diffDays: occ.diffDays,
          detail: `${years} year${years === 1 ? '' : 's'} with Smaatech · ${relativeDayText(occ.diffDays, occ.occurrence)}`,
        });
      }
    }
  }
  raw.sort((a, b) => a.diffDays - b.diffDays);

  const wishes = await Wish.find({ employeeId: { $in: raw.map((r) => r.empId) } });
  const wishedSet = new Set(wishes.map((w) => `${String(w.employeeId)}-${w.type}-${w.year}`));

  const entries = raw.map((r) => ({
    id: `${r.empId}-${r.type}-${r.year}`,
    type: r.type,
    name: r.name,
    detail: r.detail,
    wished: wishedSet.has(`${r.empId}-${r.type}-${r.year}`),
  }));
  res.json(entries);
});

// Parses the synthetic id back into employeeId/type/year and records the
// acknowledgment; the unique (employeeId, type, year) index makes this
// naturally idempotent.
router.patch('/:id', requireRole('HR Manager'), async (req, res) => {
  const parts = req.params.id.split('-');
  const [employeeId, type, yearStr] = parts;
  const year = Number(yearStr);
  if (parts.length !== 3 || !mongoose.Types.ObjectId.isValid(employeeId) || !['birthday', 'anniv'].includes(type) || !year) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid celebration id.' } });
  }
  await Wish.findOneAndUpdate(
    { employeeId, type, year },
    { employeeId, type, year },
    { upsert: true },
  );
  res.json({ id: req.params.id, wished: true });
});

export default router;
