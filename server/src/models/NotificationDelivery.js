import mongoose from 'mongoose';

/**
 * One row per (notification, channel) delivery attempt sequence.
 *
 * WHY: email delivery was fire-and-forget. A bounce or an SMTP outage was
 * logged once and then gone — nothing retried it, and nobody could answer
 * "was the payslip email actually sent?" after the fact. For a system that
 * notifies people about pay, leave decisions and exits, "we think so" is not
 * an acceptable answer.
 *
 * This makes delivery a durable, inspectable record: what was sent, on which
 * channel, to whom, how many times it was tried, and why it failed.
 */
const notificationDeliverySchema = new mongoose.Schema({
  company: { type: String, required: true, index: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  recipientAddress: { type: String, default: '' },
  notificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },

  channel: { type: String, required: true }, // in-app | email | sms | whatsapp | push
  title: { type: String, default: '' },
  type: { type: String, default: 'system' },

  // pending    — queued, not yet attempted
  // sent       — the channel accepted it
  // failed     — attempted and failed; will be retried while attempts remain
  // exhausted  — retried to the limit and still failing; needs a human
  // unsupported— the channel is configured but this build cannot deliver on it
  status: { type: String, default: 'pending', index: true },

  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  lastError: { type: String, default: '' },
  lastAttemptAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: null, index: true },
  sentAt: { type: Date, default: null },

  // Set by a caller that must not send the same thing twice (a payslip for one
  // cycle, one leave decision). The partial unique index below makes that a
  // guarantee rather than an intention.
  dedupeKey: { type: String, default: null },

  // Retained long enough to answer "did it go out?" for a full pay cycle.
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + Number(process.env.NOTIFICATION_DELIVERY_RETENTION_DAYS || 120) * 86400000),
  },
}, { timestamps: true });

// Unique only where a dedupeKey is actually set, so ordinary notifications are
// unaffected while a keyed one can only ever exist once per channel.
notificationDeliverySchema.index(
  { company: 1, dedupeKey: 1, channel: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
notificationDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
notificationDeliverySchema.index({ company: 1, createdAt: -1 });
notificationDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.NotificationDelivery
  || mongoose.model('NotificationDelivery', notificationDeliverySchema);
