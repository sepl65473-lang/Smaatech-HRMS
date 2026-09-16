import Notification from '../models/Notification.js';
import NotificationDelivery from '../models/NotificationDelivery.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import { sendEmail } from './mailer.js';
import logger from './logger.js';

// Settings.notifyChannels stores display labels ('In-app','Email','WhatsApp',
// 'SMS'); lower-cased they match the internal channel keys used below.
export function resolveChannels(settingsDoc, category, fallback = ['in-app']) {
  const configured = settingsDoc?.notifyChannels?.[category];
  if (!configured || !configured.length) return fallback;
  return configured.map((c) => String(c).toLowerCase());
}

// Settings.notificationTemplates entries look like "Subject: X\n\nBody..."
// with {placeholder} tokens. Returns null if no template is configured, so
// callers can fall back to their existing hardcoded title/message.
export function fillTemplate(raw, vars = {}) {
  if (!raw || !raw.trim()) return null;
  const subjectMatch = raw.match(/^Subject:\s*(.+?)\r?\n\r?\n/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;
  const body = subjectMatch ? raw.slice(subjectMatch[0].length) : raw;
  const fill = (s) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v ?? ''), s);
  return { subject: subject ? fill(subject) : null, body: fill(body).trim() };
}


// Retry schedule for a channel that failed for a reason that might pass
// (an SMTP timeout, a provider outage). Exponential, capped, with the last
// attempt roughly two hours out.
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000, 120 * 60_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

export function nextAttemptDelay(attempts) {
  return RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Opens (or finds) the delivery record for one channel.
 *
 * Returns null when a dedupeKey names something already delivered — that is
 * the duplicate-prevention path, and the caller must then NOT send again.
 */
async function openDelivery({ company, recipientId, recipientAddress, channel, title, type, dedupeKey, notificationId }) {
  if (dedupeKey) {
    const existing = await NotificationDelivery.findOne({ company, dedupeKey, channel });
    if (existing) {
      // Already sent, or still being retried by the job — either way this is
      // not a second send.
      if (['sent', 'pending', 'failed'].includes(existing.status)) return null;
      return existing;
    }
  }
  try {
    return await NotificationDelivery.create({
      company, recipientId, recipientAddress, channel, title, type,
      dedupeKey: dedupeKey || null, notificationId, maxAttempts: MAX_ATTEMPTS,
    });
  } catch (err) {
    // The partial unique index caught a concurrent duplicate: somebody else is
    // already delivering this exact thing.
    if (err.code === 11000) return null;
    throw err;
  }
}

async function markSent(delivery) {
  if (!delivery) return;
  delivery.status = 'sent';
  delivery.attempts += 1;
  delivery.lastAttemptAt = new Date();
  delivery.sentAt = new Date();
  delivery.nextAttemptAt = null;
  await delivery.save();
}

async function markFailed(delivery, error) {
  if (!delivery) return;
  delivery.attempts += 1;
  delivery.lastAttemptAt = new Date();
  delivery.lastError = String(error?.message || error).slice(0, 500);
  if (delivery.attempts >= delivery.maxAttempts) {
    // Out of retries. Left as a record a human can find, rather than
    // disappearing into a log line.
    delivery.status = 'exhausted';
    delivery.nextAttemptAt = null;
  } else {
    delivery.status = 'failed';
    delivery.nextAttemptAt = new Date(Date.now() + nextAttemptDelay(delivery.attempts));
  }
  await delivery.save();
}

async function markUnsupported(delivery, reason) {
  if (!delivery) return;
  // Not retried: retrying a channel this build cannot send on would never
  // succeed and would only bury the real failures.
  delivery.status = 'unsupported';
  delivery.lastError = reason;
  delivery.nextAttemptAt = null;
  await delivery.save();
}

/**
 * Returns { notification, delivered, undelivered }.
 *
 * `undelivered` names every requested channel that this build cannot actually
 * send on, so a caller (or an operator reading the logs) can tell the
 * difference between "sent" and "silently dropped".
 *
 * Every channel also gets a durable NotificationDelivery record, so a failed
 * email is retried by the delivery job instead of vanishing into a log line,
 * and "was it sent?" has an answer months later. Pass `dedupeKey` for anything
 * that must not be sent twice (a payslip for one cycle, one leave decision) —
 * a second call with the same key sends nothing.
 */
export async function sendNotification({ recipientId, title, message, type = 'system', actionUrl = '', channels = ['in-app'], emailOverride = null, company = 'Smaatech', dedupeKey = null }) {
  const delivered = [];
  const undelivered = [];
  const duplicates = [];
  try {
    // 1. In-app notification creation
    let dbNotif = null;
    if (channels.includes('in-app')) {
      const record = await openDelivery({
        company, recipientId, channel: 'in-app', title, type, dedupeKey,
      });
      if (record) {
        dbNotif = await Notification.create({
          recipientId,
          title,
          message,
          type,
          actionUrl,
          company,
        });
        record.notificationId = dbNotif._id;
        await markSent(record);
        delivered.push('in-app');
      } else {
        // A dedupeKey said this was already delivered. Sending it again would
        // show the person the same thing twice.
        duplicates.push('in-app');
      }
    }

    // 2. Fetch User & Employee details if we have targeted recipientId
    let recipientUser = null;
    let recipientEmp = null;
    if (recipientId) {
      recipientUser = await User.findById(recipientId);
      if (recipientUser && recipientUser.employeeId) {
        recipientEmp = await Employee.findById(recipientUser.employeeId);
      }
    }

    const emailTo = recipientUser?.email;

    // 3. Process email channel
    if (channels.includes('email') && emailTo) {
      const record = await openDelivery({
        company, recipientId, recipientAddress: emailTo, channel: 'email',
        title, type, dedupeKey, notificationId: dbNotif?._id,
      });
      if (!record) {
        duplicates.push('email');
      } else if (process.env.BREVO_API_KEY && process.env.SMTP_USER) {
        const subject = emailOverride?.subject || title;
        const body = emailOverride?.body || message;
        try {
          await sendEmail({ to: emailTo, subject, text: body });
          await markSent(record);
          delivered.push('email');
        } catch (err) {
          // One recipient's bounce must not abort the whole notification — and
          // it is now recorded for retry rather than only logged.
          await markFailed(record, err);
          undelivered.push('email');
          logger.error('[notifications] email to %s failed (attempt %d): %s', emailTo, record.attempts, err.message);
        }
      } else {
        await markUnsupported(record, 'BREVO_API_KEY/SMTP_USER are not configured');
        undelivered.push('email');
        logger.warn('[notifications] email requested but BREVO_API_KEY/SMTP_USER are not set — "%s" was not delivered to %s.', title, emailTo);
      }
    }

    // 4-6. SMS / WhatsApp / Push are NOT IMPLEMENTED.
    //
    // There is no Twilio, Gateway or push client in this codebase — these
    // branches only ever wrote a console line. That matters because HR can
    // select these channels in Settings > Notifications and the old code
    // returned success, so a company could configure "notify by SMS", see no
    // error anywhere, and quietly deliver nothing for months.
    //
    // They are reported as undelivered instead, and the in-app notification
    // (which IS real) always still goes out, so nothing is lost.
    for (const channel of ['sms', 'whatsapp', 'push']) {
      if (channels.includes(channel)) {
        // eslint-disable-next-line no-await-in-loop
        const record = await openDelivery({
          company, recipientId, channel, title, type, dedupeKey, notificationId: dbNotif?._id,
        });
        // eslint-disable-next-line no-await-in-loop
        await markUnsupported(record, 'channel not implemented in this build');
        undelivered.push(channel);
        logger.warn('[notifications] channel "%s" is configured but NOT IMPLEMENTED — "%s" was not delivered to %s. Falling back to in-app only.',
          channel, title, recipientUser?.name || recipientId);
      }
    }

    return { notification: dbNotif, delivered, undelivered, duplicates };
  } catch (err) {
    logger.error('[notifications] failed: %o', err);
    return { notification: null, delivered, duplicates, undelivered: [...undelivered, ...channels.filter((c) => !delivered.includes(c))] };
  }
}

// The channels this build can actually deliver on. Anything else is config the
// product accepts but cannot honour.
export const IMPLEMENTED_CHANNELS = ['in-app', 'email'];
export const UNIMPLEMENTED_CHANNELS = ['sms', 'whatsapp', 'push'];

/**
 * Retries deliveries that failed for a reason that might have passed.
 *
 * Run by the scheduler (lib/jobs.js). Only ever touches 'failed' rows whose
 * backoff has elapsed — 'unsupported' is never retried, because a channel this
 * build cannot send on will not start working on the second attempt.
 *
 * Returns a summary so the caller can log what happened.
 */
export async function retryPendingDeliveries({ limit = 50, now = new Date() } = {}) {
  const due = await NotificationDelivery.find({
    status: 'failed',
    channel: 'email',
    nextAttemptAt: { $lte: now },
  }).sort({ nextAttemptAt: 1 }).limit(limit);

  const summary = { considered: due.length, sent: 0, failed: 0, exhausted: 0 };

  for (const record of due) {
    if (!record.recipientAddress) {
      // eslint-disable-next-line no-await-in-loop
      await markUnsupported(record, 'no recipient address on file');
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!(process.env.BREVO_API_KEY && process.env.SMTP_USER)) {
      // eslint-disable-next-line no-await-in-loop
      await markUnsupported(record, 'BREVO_API_KEY/SMTP_USER are not configured');
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const notification = record.notificationId
        ? await Notification.findById(record.notificationId)
        : null;
      // eslint-disable-next-line no-await-in-loop
      await sendEmail({
        to: record.recipientAddress,
        subject: record.title,
        text: notification?.message || record.title,
      });
      // eslint-disable-next-line no-await-in-loop
      await markSent(record);
      summary.sent += 1;
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await markFailed(record, err);
      if (record.status === 'exhausted') summary.exhausted += 1;
      else summary.failed += 1;
    }
  }

  if (summary.considered) {
    logger.info('[notifications] retry pass: %d due, %d sent, %d still failing, %d exhausted',
      summary.considered, summary.sent, summary.failed, summary.exhausted);
  }
  return summary;
}

/** Operator view: what is stuck and needs a human. */
export async function deliveryHealth(company) {
  const rows = await NotificationDelivery.aggregate([
    { $match: company ? { company } : {} },
    { $group: { _id: { channel: '$channel', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const summary = {};
  for (const row of rows) {
    summary[row._id.channel] = summary[row._id.channel] || {};
    summary[row._id.channel][row._id.status] = row.count;
  }
  return summary;
}
