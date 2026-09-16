import mongoose from 'mongoose';

/**
 * An immutable record of one change to someone's employment.
 *
 * WHY: confirmation, transfer, promotion and salary revision were not recorded
 * anywhere. An employee's department or salary could be edited on the profile
 * form and the previous value was simply gone — so "what was she earning
 * before the revision, who approved it, and from when" had no answer, and a
 * salary change and a typo looked identical in the database.
 *
 * Events are append-only. Correcting one means recording another (a reversal),
 * never editing history.
 */
export const LIFECYCLE_EVENT_TYPES = [
  'probation-started',
  'probation-extended',
  'confirmed',
  'transferred',
  'promoted',
  'salary-revised',
  'status-changed',
  'notice-started',
  'exited',
];

const lifecycleEventSchema = new mongoose.Schema({
  company: { type: String, required: true, index: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employeeName: { type: String, default: '' },

  type: { type: String, enum: LIFECYCLE_EVENT_TYPES, required: true },

  // The date the change takes effect for the business — which is routinely not
  // the date someone got round to entering it, and is what payroll and reports
  // must use.
  effectiveDate: { type: String, required: true }, // 'YYYY-MM-DD'

  // What actually changed. Only the fields this event touches are present, and
  // both sides are kept so the record stands on its own.
  changes: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },

  reason: { type: String, default: '' },
  note: { type: String, default: '' },

  actor: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
    role: { type: String, default: '' },
  },

  // Set when this event reverses an earlier one, so a correction is traceable
  // to what it corrected instead of looking like a second real change.
  reversesEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'LifecycleEvent', default: null },

  // Guards a double-click or a retried request from recording the same change
  // twice. Unique only where set.
  dedupeKey: { type: String, default: null },
}, { timestamps: true });

lifecycleEventSchema.index({ company: 1, empId: 1, createdAt: -1 });
lifecycleEventSchema.index({ company: 1, type: 1, effectiveDate: -1 });
lifecycleEventSchema.index(
  { company: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

lifecycleEventSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.models.LifecycleEvent
  || mongoose.model('LifecycleEvent', lifecycleEventSchema);
