import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

// notificationService's email channel used to run its own raw Gmail-SMTP
// transporter (broken on Render, silently swallowed by the outer try/catch —
// see mailer.js's history) and now shares mailer.js's Brevo-backed sendEmail.
vi.mock('./mailer.js', () => ({
  sendEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB } = await import('../test-utils/testDb.js');
const User = (await import('../models/User.js')).default;
const Notification = (await import('../models/Notification.js')).default;
const { sendEmail } = await import('./mailer.js');
const { resolveChannels, fillTemplate, sendNotification } = await import('./notificationService.js');

beforeAll(async () => {
  await startTestDB();
}, 60000);

afterAll(async () => {
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  vi.clearAllMocks();
});

describe('resolveChannels', () => {
  it('lower-cases configured channel labels', () => {
    const settingsDoc = { notifyChannels: { leave: ['In-app', 'Email'] } };
    expect(resolveChannels(settingsDoc, 'leave')).toEqual(['in-app', 'email']);
  });

  it('falls back to the given default when the category is unconfigured', () => {
    expect(resolveChannels({ notifyChannels: {} }, 'payroll')).toEqual(['in-app']);
  });

  it('falls back to the given default when notifyChannels is missing entirely', () => {
    expect(resolveChannels({}, 'leave', ['in-app', 'email'])).toEqual(['in-app', 'email']);
  });

  it('falls back when the configured list is empty', () => {
    const settingsDoc = { notifyChannels: { leave: [] } };
    expect(resolveChannels(settingsDoc, 'leave')).toEqual(['in-app']);
  });
});

describe('fillTemplate', () => {
  it('returns null for an empty or missing template', () => {
    expect(fillTemplate('')).toBeNull();
    expect(fillTemplate('   ')).toBeNull();
    expect(fillTemplate(undefined)).toBeNull();
  });

  it('splits a "Subject: X\\n\\nBody" template into subject and body', () => {
    const raw = 'Subject: Leave Approval Notification\n\nDear {employee},\n\nYour leave for {date} is approved.';
    const result = fillTemplate(raw, { employee: 'Priya Sharma', date: '2026-08-01 to 2026-08-03' });
    expect(result.subject).toBe('Leave Approval Notification');
    expect(result.body).toBe('Dear Priya Sharma,\n\nYour leave for 2026-08-01 to 2026-08-03 is approved.');
  });

  it('treats a template with no "Subject:" line as body-only', () => {
    const result = fillTemplate('Hi {employee}, your claim is ready.', { employee: 'Dev Gupta' });
    expect(result.subject).toBeNull();
    expect(result.body).toBe('Hi Dev Gupta, your claim is ready.');
  });

  it('leaves an unmatched placeholder untouched', () => {
    const result = fillTemplate('Hello {employee}, code {otp}', { employee: 'Kavya' });
    expect(result.body).toBe('Hello Kavya, code {otp}');
  });
});

async function seedRecipient() {
  return User.create({
    name: 'Notify Me', email: 'notify-me@example.com', passwordHash: 'x', role: 'Employee', company: 'NotifyCo', active: true,
  });
}

describe('sendNotification email channel', () => {
  it('sends via Brevo (mailer.sendEmail) when configured, and still creates the in-app record', async () => {
    process.env.BREVO_API_KEY = 'test-key';
    process.env.SMTP_USER = 'sender@example.com';
    const user = await seedRecipient();

    const result = await sendNotification({
      recipientId: user._id, title: 'Leave approved', message: 'Your leave was approved.', channels: ['in-app', 'email'], company: 'NotifyCo',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email, subject: 'Leave approved', text: 'Your leave was approved.' }));
    expect(result).not.toBeNull();
    const stored = await Notification.findOne({ recipientId: user._id });
    expect(stored.title).toBe('Leave approved');
  });

  it('falls back to the console scaffold without throwing when email is not configured', async () => {
    delete process.env.BREVO_API_KEY;
    const user = await seedRecipient();

    const result = await sendNotification({
      recipientId: user._id, title: 'Payroll run', message: 'Payslip ready.', channels: ['email'], company: 'NotifyCo',
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result).toBeNull(); // channels didn't include 'in-app', so no DB record either
  });

  it('never lets a send failure escape — sendNotification stays fire-and-forget', async () => {
    process.env.BREVO_API_KEY = 'test-key';
    process.env.SMTP_USER = 'sender@example.com';
    sendEmail.mockRejectedValueOnce(new Error('Brevo send failed (401): unauthorized'));
    const user = await seedRecipient();

    await expect(sendNotification({
      recipientId: user._id, title: 'x', message: 'y', channels: ['email'], company: 'NotifyCo',
    })).resolves.not.toThrow();
  });
});
