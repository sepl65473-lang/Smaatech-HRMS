// Same-day attendance reminders: who gets one, who must not, and that a
// reminder is sent once no matter how many times the job runs.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const sendEmail = vi.fn(async () => {});
vi.mock('./mailer.js', () => ({
  sendEmail: (...args) => sendEmail(...args),
  sendOtpEmail: vi.fn(async () => {}),
}));

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const { sendAttendanceReminders, reminderDue, reminderConfig, EVENTS } = await import('./attendanceReminderJob.js');
const { retryPendingDeliveries } = await import('./notificationService.js');
const Employee = (await import('../models/Employee.js')).default;
const Attendance = (await import('../models/Attendance.js')).default;
const Holiday = (await import('../models/Holiday.js')).default;
const Leave = (await import('../models/Leave.js')).default;
const Settings = (await import('../models/Settings.js')).default;
const NotificationDelivery = (await import('../models/NotificationDelivery.js')).default;

const COMPANY = 'ReminderCo';
const WEDNESDAY = '2026-09-30';
const SATURDAY = '2026-10-03';
const SUNDAY = '2026-10-04';

// Restored, not deleted — process.env is shared with other test files.
const ORIGINAL_ENV = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  SMTP_USER: process.env.SMTP_USER,
  ATTENDANCE_REMINDERS_ENABLED: process.env.ATTENDANCE_REMINDERS_ENABLED,
};

const run = (time, date = WEDNESDAY, now = new Date()) => sendAttendanceReminders({ date, time, now });
const recipients = () => sendEmail.mock.calls.map(([arg]) => arg.to);

async function hire(name, extra = {}) {
  return Employee.create({
    name, email: `${name.toLowerCase()}@example.com`, dept: 'Engineering', role: 'Engineer', company: COMPANY, status: 'active', ...extra,
  });
}

async function punch(emp, { checkIn = null, checkOut = null, status = 'present', date = WEDNESDAY } = {}) {
  return Attendance.create({ empId: emp._id, name: emp.name, dept: emp.dept, date, checkIn, checkOut, status, company: COMPANY });
}

beforeAll(async () => {
  await startTestDB();
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await stopTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  await Settings.create({ _id: COMPANY, orgName: 'Smaatech Engineering' });
  sendEmail.mockReset();
  sendEmail.mockImplementation(async () => {});
  process.env.BREVO_API_KEY = 'test-key';
  process.env.SMTP_USER = 'hrms@example.com';
  delete process.env.ATTENDANCE_REMINDERS_ENABLED;
});

describe('missing Check-In', () => {
  it('emails only the employee who has not checked in, after the afternoon cutoff', async () => {
    const rahul = await hire('Rahul');
    const priya = await hire('Priya');
    await punch(rahul, { status: 'absent' });
    await punch(priya, { checkIn: '09:42' });

    const result = await run('14:00');

    expect(result.sent).toBe(1);
    expect(recipients()).toEqual(['rahul@example.com']);
    const [{ subject, text, html }] = sendEmail.mock.calls[0];
    expect(subject).toMatch(/Check-In is missing/);
    expect(subject).toContain('30 September 2026');
    expect(text).toContain('Dear Rahul');
    expect(text).toContain('Wednesday, 30 September 2026');
    expect(text).toContain('Smaatech Engineering HRMS');
    expect(html).toContain('Check-In Not Recorded');
  });

  it('also covers a day whose attendance row was never created', async () => {
    await hire('Rahul');
    await run('14:30');
    expect(recipients()).toEqual(['rahul@example.com']);
  });

  it('sends nothing before the cutoff', async () => {
    await hire('Rahul');
    const result = await run('13:59');
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('waits for a later shift to start before reminding', async () => {
    const emp = await hire('Evening');
    await Settings.updateOne({ _id: COMPANY }, { employeeShifts: { [String(emp._id)]: 'shift_evening' } });

    await run('14:10'); // shift starts 14:00, 15 min grace
    expect(sendEmail).not.toHaveBeenCalled();
    await run('14:30');
    expect(recipients()).toEqual(['evening@example.com']);
  });
});

describe('missing Check-Out', () => {
  it('emails the employee who checked in but never checked out, after the end-of-day cutoff', async () => {
    const rahul = await hire('Rahul');
    await punch(rahul, { checkIn: '09:42' });

    await run('18:30');
    expect(sendEmail).not.toHaveBeenCalled();

    const result = await run('19:00');
    expect(result.sent).toBe(1);
    expect(recipients()).toEqual(['rahul@example.com']);
    const [{ subject, text }] = sendEmail.mock.calls[0];
    expect(subject).toMatch(/Check-Out is missing/);
    expect(text).toContain('Check-In recorded at: 09:42');
  });

  it('never reminds an overnight shift about check-out on the day it started', async () => {
    const emp = await hire('Night');
    await Settings.updateOne({ _id: COMPANY }, { employeeShifts: { [String(emp._id)]: 'shift_night' } });
    await punch(emp, { checkIn: '22:05' });
    await run('23:30');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('complete attendance and people not expected to work', () => {
  it('sends nothing when the day is complete', async () => {
    const emp = await hire('Done');
    await punch(emp, { checkIn: '09:00', checkOut: '18:05' });
    const result = await run('23:30');
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not send a Check-In reminder to someone who has checked in (before the check-out cutoff)', async () => {
    const emp = await hire('In');
    await punch(emp, { checkIn: '09:00' });
    await run('15:00');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips approved leave, but not pending or declined leave', async () => {
    const onLeave = await hire('Approved');
    const pending = await hire('Pending');
    const leave = (emp, status) => Leave.create({ empId: emp._id, name: emp.name, type: 'casual', start: '2026-09-29', end: '2026-10-01', status, company: COMPANY });
    await leave(onLeave, 'approved');
    await leave(pending, 'pending');

    await run('14:00');
    expect(recipients()).toEqual(['pending@example.com']);
  });

  it('skips a row already marked leave or holiday', async () => {
    const a = await hire('LeaveRow');
    const b = await hire('HolidayRow');
    await punch(a, { status: 'leave' });
    await punch(b, { status: 'holiday' });
    await run('20:00');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips a company holiday', async () => {
    await hire('Rahul');
    await Holiday.create({ name: 'Company Day', date: '30 Sep, Wed', company: COMPANY });
    await run('20:00');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips the weekly off from Settings.workWeek', async () => {
    await hire('Rahul');
    await run('20:00', SUNDAY);
    await run('20:00', SATURDAY); // 5-day week: Saturday off
    expect(sendEmail).not.toHaveBeenCalled();

    await Settings.updateOne({ _id: COMPANY }, { workWeek: '6-day' });
    await run('20:00', SATURDAY);
    expect(recipients()).toEqual(['rahul@example.com']);
  });

  it('skips inactive, exited, terminated and on-leave employees, and those without an email', async () => {
    await hire('Exited', { status: 'exited' });
    await hire('Terminated', { status: 'terminated' });
    await hire('Away', { status: 'on-leave' });
    await hire('Gone', { employmentStage: 'Exited' });
    await hire('Future', { joinDate: '2026-10-15' });
    await Employee.create({ name: 'NoEmail', dept: 'Engineering', company: COMPANY, status: 'active' });
    const remote = await hire('Remote', { status: 'remote' });

    await run('14:00');
    expect(recipients()).toEqual([`${remote.name.toLowerCase()}@example.com`]);
  });

  it('can be switched off', async () => {
    await hire('Rahul');
    process.env.ATTENDANCE_REMINDERS_ENABLED = 'false';
    const result = await run('20:00');
    expect(result.disabled).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('records nothing when email is not configured, so it can send once it is', async () => {
    await hire('Rahul');
    delete process.env.BREVO_API_KEY;
    const result = await run('14:00');
    expect(result.emailNotConfigured).toBe(true);
    expect(await NotificationDelivery.countDocuments()).toBe(0);

    process.env.BREVO_API_KEY = 'test-key';
    await run('14:30');
    expect(recipients()).toEqual(['rahul@example.com']);
  });
});

describe('no duplicates', () => {
  it('sends each reminder once however many times the job runs', async () => {
    const rahul = await hire('Rahul');
    await punch(rahul, { status: 'absent' });
    await run('14:00');
    await run('14:30');
    await Promise.all([run('15:00'), run('15:00'), run('15:00')]);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Checks in late and then forgets to check out: that is a different event.
    await Attendance.updateOne({ empId: rahul._id, date: WEDNESDAY }, { checkIn: '15:10', status: 'late' });
    await run('19:00');
    await run('19:30');
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].subject).toMatch(/Check-Out/);

    const deliveries = await NotificationDelivery.find({ company: COMPANY }).lean();
    expect(deliveries.map((d) => d.status)).toEqual(['sent', 'sent']);
  });

  it('a new day is a new reminder', async () => {
    await hire('Rahul');
    await run('14:00', '2026-09-30');
    await run('14:00', '2026-10-01');
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe('email failure and retry', () => {
  it('records the failure and retries after the backoff, sending exactly once', async () => {
    await hire('Rahul');
    sendEmail.mockRejectedValueOnce(new Error('Brevo send failed (503)'));

    const t0 = new Date();
    const first = await run('14:00', WEDNESDAY, t0);
    expect(first.failed).toBe(1);
    let record = await NotificationDelivery.findOne({ company: COMPANY });
    expect(record.status).toBe('failed');
    expect(record.attempts).toBe(1);
    expect(record.lastError).toMatch(/503/);
    expect(record.type).toBe('attendance-reminder');

    // Before the backoff has elapsed: no resend.
    await run('14:00', WEDNESDAY, new Date(t0.getTime() + 10_000));
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // The generic retry pass leaves it alone — it cannot re-check attendance.
    await retryPendingDeliveries({ now: new Date(t0.getTime() + 3_600_000) });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const later = new Date(t0.getTime() + 3_600_000);
    const retry = await run('15:00', WEDNESDAY, later);
    expect(retry.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    record = await NotificationDelivery.findOne({ company: COMPANY });
    expect(record.status).toBe('sent');
    expect(record.attempts).toBe(2);

    await run('16:00', WEDNESDAY, new Date(later.getTime() + 3_600_000));
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('does not retry a Check-In reminder once the employee has checked in', async () => {
    const rahul = await hire('Rahul');
    sendEmail.mockRejectedValueOnce(new Error('timeout'));
    const t0 = new Date();
    await run('14:00', WEDNESDAY, t0);
    await punch(rahul, { checkIn: '14:20', status: 'late' });

    await run('15:00', WEDNESDAY, new Date(t0.getTime() + 3_600_000));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('reminderDue', () => {
  const general = { start: '09:00', end: '18:00', graceMins: 15 };
  const cfg = { checkInCutoff: 14 * 60, checkOutCutoff: 19 * 60, checkOutGraceMins: 60 };

  it('picks the right event', () => {
    expect(reminderDue(null, general, 14 * 60, cfg)).toBe(EVENTS.CHECK_IN);
    expect(reminderDue({ checkIn: '09:00' }, general, 19 * 60, cfg)).toBe(EVENTS.CHECK_OUT);
    expect(reminderDue({ checkIn: '09:00', checkOut: '18:00' }, general, 23 * 60, cfg)).toBeNull();
  });

  it('never reminds an evening shift about check-out that day when end + grace passes midnight', () => {
    const late = { start: '15:00', end: '23:30', graceMins: 15 };
    expect(reminderDue({ checkIn: '15:00' }, late, 23 * 60 + 59, cfg)).toBeNull();
  });

  it('reads the cutoffs from the environment and falls back on bad values', () => {
    const saved = { ...process.env };
    process.env.ATTENDANCE_CHECKIN_CUTOFF = '13:30';
    process.env.ATTENDANCE_CHECKOUT_CUTOFF = 'not-a-time';
    const config = reminderConfig();
    expect(config.checkInCutoff).toBe(13 * 60 + 30);
    expect(config.checkOutCutoff).toBe(19 * 60);
    process.env.ATTENDANCE_CHECKIN_CUTOFF = saved.ATTENDANCE_CHECKIN_CUTOFF ?? '';
    process.env.ATTENDANCE_CHECKOUT_CUTOFF = saved.ATTENDANCE_CHECKOUT_CUTOFF ?? '';
  });
});
