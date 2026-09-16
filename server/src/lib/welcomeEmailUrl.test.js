import { describe, it, expect } from 'vitest';
import { portalUrl } from './mailer.js';
import { generateWelcomeEmail } from './templates/welcomeEmail.js';

/**
 * Guards a launch-critical onboarding defect.
 *
 * generateWelcomeEmail carried a hardcoded portalUrl default and
 * sendWelcomeEmail never passed one, so every onboarding email shipped a
 * "Sign In to HRMS" button pointing at one fixed domain regardless of where
 * the deployment actually lives. That domain was verified unreachable, which
 * means each newly onboarded employee received a dead link - and onboarding
 * 100 employees would have produced 100 dead links.
 *
 * The address now comes from configuration, and a missing value omits the
 * button rather than shipping something broken.
 */
describe('portalUrl resolution', () => {
  it('prefers an explicit APP_PORTAL_URL', () => {
    expect(portalUrl({ APP_PORTAL_URL: 'https://hr.example.com', CLIENT_ORIGIN: 'https://other.example.com' }))
      .toBe('https://hr.example.com');
  });

  it('falls back to the deployed client origin', () => {
    expect(portalUrl({ CLIENT_ORIGIN: 'https://smaatech-hrms.vercel.app' }))
      .toBe('https://smaatech-hrms.vercel.app');
  });

  it('uses the FIRST origin when several are configured', () => {
    // The rest are staging/preview origins; an employee must be sent to the
    // real one.
    expect(portalUrl({ CLIENT_ORIGIN: 'https://prod.example.com,https://staging.example.com' }))
      .toBe('https://prod.example.com');
  });

  it('trims a trailing slash so the link is not doubled up', () => {
    expect(portalUrl({ CLIENT_ORIGIN: 'https://prod.example.com/' })).toBe('https://prod.example.com');
  });

  it('returns null rather than inventing an address', () => {
    expect(portalUrl({})).toBeNull();
    expect(portalUrl({ CLIENT_ORIGIN: '' })).toBeNull();
  });
});

describe('welcome email content', () => {
  const base = { userName: 'Asha', role: 'Employee', tempPassword: 'Temp#12345' };

  it('links to the configured deployment', () => {
    const { html, text } = generateWelcomeEmail({ ...base, portalUrl: 'https://smaatech-hrms.vercel.app' });
    expect(html).toContain('href="https://smaatech-hrms.vercel.app"');
    expect(text).toContain('https://smaatech-hrms.vercel.app');
  });

  it('carries no hardcoded domain any more', () => {
    const { html, text } = generateWelcomeEmail({ ...base, portalUrl: 'https://smaatech-hrms.vercel.app' });
    expect(html).not.toContain('hrms.smaatech.co');
    expect(text).not.toContain('hrms.smaatech.co');
  });

  it('omits the button entirely when no address is configured', () => {
    const { html, text } = generateWelcomeEmail(base);
    expect(html).not.toContain('Sign In to HRMS');
    expect(html).not.toContain('href="null"');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('still delivers the credentials the employee needs', () => {
    const { text } = generateWelcomeEmail({ ...base, portalUrl: 'https://smaatech-hrms.vercel.app' });
    expect(text).toContain('Asha');
    expect(text).toContain('Temp#12345');
  });
});
