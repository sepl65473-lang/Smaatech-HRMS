// Render's free-tier services block all outbound SMTP ports (25/465/587),
// so raw SMTP (via nodemailer) can never reach Gmail from production —
// every send silently times out. Brevo's transactional email HTTP API goes
// over regular HTTPS (443), which is never blocked, so we call that
// directly instead of speaking SMTP at all.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

export async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.SMTP_USER;
  if (!apiKey || !fromEmail) {
    throw new Error('Email sending is not configured (BREVO_API_KEY/SMTP_USER missing).');
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Smaatech HRMS', email: fromEmail },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || `<p>${text.replace(/\n/g, '<br>')}</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

// Real email delivery — replaces the old in-app-toast "simulated OTP".
// If email isn't configured yet, this throws rather than silently pretending
// to send, so the caller can surface a clear error instead of a fake success.
export async function sendOtpEmail(toEmail, otp, purpose = 'password reset') {
  await sendEmail({
    to: toEmail,
    subject: `Your verification code: ${otp}`,
    text: `Your verification code for ${purpose} is ${otp}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your verification code for <strong>${purpose}</strong> is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${otp}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}

/**
 * The HRMS address a welcome email should point a new employee at.
 *
 * The template carried a hardcoded default and sendWelcomeEmail never passed
 * anything, so every onboarding email shipped a "Sign In to HRMS" button
 * aimed at that one fixed domain regardless of where this deployment actually
 * lives. Verified unreachable from here, which means each new employee would
 * have received a dead link.
 *
 * CLIENT_ORIGIN is the right source: it is already the deployed frontend
 * origin, production refuses to start without it (see lib/startupChecks.js),
 * and it is exactly the origin the browser client is served from. The first
 * entry is used when several are configured, since the rest are staging or
 * preview origins. APP_PORTAL_URL overrides it for the case where the address
 * employees should use differs from the CORS origin.
 */
export function portalUrl(env = process.env) {
  const explicit = (env.APP_PORTAL_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const first = (env.CLIENT_ORIGIN || '').split(',')[0].trim();
  if (first) return first.replace(/\/$/, '');
  return null;
}

export async function sendWelcomeEmail({ toEmail, userName, role, tempPassword, company = 'Smaatech', userId = null, idempotencyKey = '' }) {
  const EmailLog = (await import('../models/EmailLog.js')).default;
  const { generateWelcomeEmail } = await import('./templates/welcomeEmail.js');

  const key = idempotencyKey || `${company}_welcome_${toEmail}`;
  if (key) {
    const existing = await EmailLog.findOne({ company, idempotencyKey: key, status: 'SENT' });
    if (existing) {
      console.log(`[Mailer] Duplicate welcome email skipped via idempotency key: ${key}`);
      return { sent: true, idempotent: true, log: existing };
    }
  }

  const { subject, text, html } = generateWelcomeEmail({
    userName, role, tempPassword, company, portalUrl: portalUrl(),
  });

  try {
    if (process.env.BREVO_API_KEY && process.env.SMTP_USER) {
      await sendEmail({ to: toEmail, subject, text, html });
    } else {
      console.log(`[Mailer Scaffolding] Welcome email scaffolded to ${toEmail} (Brevo API key not set).`);
    }

    const log = await EmailLog.create({
      userId,
      email: toEmail,
      emailType: 'WELCOME',
      status: 'SENT',
      idempotencyKey: key,
      company,
    });
    return { sent: true, log };
  } catch (err) {
    console.error(`[Mailer Error] Failed to send welcome email to ${toEmail}:`, err.message);
    const log = await EmailLog.create({
      userId,
      email: toEmail,
      emailType: 'WELCOME',
      status: 'FAILED',
      failureReason: err.message || 'Email delivery failed',
      idempotencyKey: key,
      company,
    });
    return { sent: false, error: err.message, log };
  }
}

