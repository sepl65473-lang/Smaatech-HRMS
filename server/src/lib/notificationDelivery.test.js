// Notification DELIVERY: durability, duplicate prevention and retry.
//
// The behaviour being pinned down here is the difference between "we called
// sendEmail" and "the person actually got it". Email used to be
// fire-and-forget — a bounce produced one log line and the notification was
// gone, with no record and no retry.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const sendEmail = vi.fn(async () => {});
vi.mock('./mailer.js', () => ({
  sendEmail: (...args) => sendEmail(...args),
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const { sendNotification, retryPendingDeliveries, deliveryHealth } = await import('./notificationService.js');
const NotificationDelivery = (await import('../models/NotificationDelivery.js')).default;
const Notification = (await import('../models/Notification.js')).default;
const User = (await import('../models/User.js')).default;

const COMPANY = 'NotifyCo';

async function seedRecipient() {
  return User.create({
    name: 'Recipient', email: 'recipient@example.com', passwordHash: 'x',
    role: 'Employee', company: COMPANY, active: true,
  });
}

// process.env is shared by every test file running in the same worker, so the
// original values are restored rather than deleted — otherwise this file
// silently unconfigures email for whichever file runs next.
const ORIGINAL_EMAIL_ENV = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  SMTP_USER: process.env.SMTP_USER,
};

function withEmailConfigured(enabled) {
  if (enabled) {
    process.env.BREVO_API_KEY = 'test-key';
    process.env.SMTP_USER = 'test-user';
    return;
  }
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_USER;
}

function restoreEmailEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_EMAIL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  await stopTestDB();
  restoreEmailEnv();
});
beforeEach(async () => {
  await clearTestDB();
  sendEmail.mockReset();
  sendEmail.mockImplementation(async () => {});
  withEmailConfigured(true);
});

describe('every delivery leaves a record', () => {
  it('records a successful in-app and email delivery', async () => {
    const user = await seedRecipient();
    const result = await sendNotification({
      recipientId: user._id, title: 'Payslip Ready', message: 'Your payslip is ready.',
      channels: ['in-app', 'email'], company: COMPANY,
    });

    expect(result.delivered).toEqual(['in-app', 'email']);
    const rows = await NotificationDelivery.find({ company: COMPANY }).sort({ channel: 1 });
    expect(rows.map((r) => r.channel)).toEqual(['email', 'in-app']);
    for (const row of rows) {
      expect(row.status).toBe('sent');
      expect(row.sentAt).toBeTruthy();
      expect(row.attempts).toBe(1);
    }
    expect(rows.find((r) => r.channel === 'email').recipientAddress).toBe('recipient@example.com');
  });

  it('records a FAILED email with the reason and a retry time', async () => {
    const user = await seedRecipient();
    sendEmail.mockRejectedValueOnce(new Error('smtp timeout'));

    const result = await sendNotification({
      recipientId: user._id, title: 'Leave Approved', message: 'Approved.',
      channels: ['in-app', 'email'], company: COMPANY,
    });
    expect(result.undelivered).toContain('email');

    const row = await NotificationDelivery.findOne({ company: COMPANY, channel: 'email' });
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/smtp timeout/);
    expect(row.attempts).toBe(1);
    // Scheduled for another go rather than dropped.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // The in-app notification still went out — one channel failing must not
    // take the others with it.
    expect(result.delivered).toContain('in-app');
    expect(await Notification.countDocuments({ company: COMPANY })).toBe(1);
  });

  it('marks a channel this build cannot send on as unsupported, never as sent', async () => {
    const user = await seedRecipient();
    const result = await sendNotification({
      recipientId: user._id, title: 'Shift Change', message: 'Changed.',
      channels: ['in-app', 'whatsapp', 'sms'], company: COMPANY,
    });
    expect(result.undelivered).toEqual(expect.arrayContaining(['whatsapp', 'sms']));

    const rows = await NotificationDelivery.find({ company: COMPANY, channel: { $in: ['sms', 'whatsapp'] } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('unsupported');
      // Not retried: it would never succeed and would bury the real failures.
      expect(row.nextAttemptAt).toBeNull();
    }
  });

  it('marks email unsupported when no provider is configured', async () => {
    withEmailConfigured(false);
    const user = await seedRecipient();
    await sendNotification({
      recipientId: user._id, title: 'X', message: 'Y', channels: ['email'], company: COMPANY,
    });
    const row = await NotificationDelivery.findOne({ company: COMPANY, channel: 'email' });
    expect(row.status).toBe('unsupported');
    expect(row.lastError).toMatch(/not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('duplicate prevention', () => {
  it('sends a keyed notification exactly once, however many times it is called', async () => {
    const user = await seedRecipient();
    const payload = {
      recipientId: user._id, title: 'Payslip Ready', message: 'Your payslip for 2026-05.',
      channels: ['in-app', 'email'], company: COMPANY, dedupeKey: 'payslip:2026-05:emp-1',
    };

    const first = await sendNotification(payload);
    const second = await sendNotification(payload);
    const third = await sendNotification(payload);

    expect(first.delivered).toEqual(['in-app', 'email']);
    expect(second.duplicates).toEqual(expect.arrayContaining(['in-app', 'email']));
    expect(third.delivered).toEqual([]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments({ company: COMPANY })).toBe(1);
    expect(await NotificationDelivery.countDocuments({ company: COMPANY, channel: 'email' })).toBe(1);
  });

  it('survives two concurrent callers with the same key', async () => {
    const user = await seedRecipient();
    const payload = {
      recipientId: user._id, title: 'Payslip Ready', message: 'Once only.',
      channels: ['email'], company: COMPANY, dedupeKey: 'payslip:2026-06:emp-1',
    };
    await Promise.all([sendNotification(payload), sendNotification(payload), sendNotification(payload)]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys and different companies independent', async () => {
    const user = await seedRecipient();
    await sendNotification({ recipientId: user._id, title: 'A', message: 'A', channels: ['email'], company: COMPANY, dedupeKey: 'k1' });
    await sendNotification({ recipientId: user._id, title: 'B', message: 'B', channels: ['email'], company: COMPANY, dedupeKey: 'k2' });
    await sendNotification({ recipientId: user._id, title: 'C', message: 'C', channels: ['email'], company: 'OtherCo', dedupeKey: 'k1' });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('does not deduplicate ordinary, unkeyed notifications', async () => {
    const user = await seedRecipient();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendNotification({ recipientId: user._id, title: 'Reminder', message: 'Again', channels: ['email'], company: COMPANY });
    }
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });
});

describe('retry', () => {
  it('retries a failed delivery once its backoff has elapsed', async () => {
    const user = await seedRecipient();
    sendEmail.mockRejectedValueOnce(new Error('provider down'));
    await sendNotification({
      recipientId: user._id, title: 'Payslip Ready', message: 'Body',
      channels: ['in-app', 'email'], company: COMPANY,
    });

    // Not yet due.
    expect((await retryPendingDeliveries()).considered).toBe(0);

    // Due now.
    const summary = await retryPendingDeliveries({ now: new Date(Date.now() + 10 * 60_000) });
    expect(summary.sent).toBe(1);

    const row = await NotificationDelivery.findOne({ company: COMPANY, channel: 'email' });
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('backs off further on each failure and finally gives up, visibly', async () => {
    const user = await seedRecipient();
    sendEmail.mockRejectedValue(new Error('still down'));
    await sendNotification({
      recipientId: user._id, title: 'Payslip Ready', message: 'Body',
      channels: ['email'], company: COMPANY,
    });

    let row = await NotificationDelivery.findOne({ company: COMPANY, channel: 'email' });
    const gaps = [];
    while (row.status === 'failed') {
      const previous = row.nextAttemptAt.getTime();
      // eslint-disable-next-line no-await-in-loop
      await retryPendingDeliveries({ now: new Date(previous + 1000) });
      // eslint-disable-next-line no-await-in-loop
      row = await NotificationDelivery.findById(row._id);
      if (row.nextAttemptAt) gaps.push(row.nextAttemptAt.getTime() - previous);
    }

    // Gives up rather than retrying for ever, and says so.
    expect(row.status).toBe('exhausted');
    expect(row.attempts).toBe(row.maxAttempts);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toMatch(/still down/);
    // Each wait was longer than the last.
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
  });

  it('never retries an unsupported channel', async () => {
    const user = await seedRecipient();
    await sendNotification({
      recipientId: user._id, title: 'X', message: 'Y', channels: ['whatsapp'], company: COMPANY,
    });
    const summary = await retryPendingDeliveries({ now: new Date(Date.now() + 86_400_000) });
    expect(summary.considered).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('deliveryHealth', () => {
  it('summarises what is stuck, per channel', async () => {
    const user = await seedRecipient();
    sendEmail.mockRejectedValueOnce(new Error('bounce'));
    await sendNotification({ recipientId: user._id, title: 'A', message: 'A', channels: ['in-app', 'email'], company: COMPANY });
    await sendNotification({ recipientId: user._id, title: 'B', message: 'B', channels: ['in-app', 'sms'], company: COMPANY });

    const health = await deliveryHealth(COMPANY);
    expect(health['in-app'].sent).toBe(2);
    expect(health.email.failed).toBe(1);
    expect(health.sms.unsupported).toBe(1);
  });
});
