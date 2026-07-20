import { describe, it, expect } from 'vitest';
import { resolveChannels, fillTemplate } from './notificationService.js';

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
