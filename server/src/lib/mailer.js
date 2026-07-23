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
