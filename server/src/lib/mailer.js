import dns from 'node:dns';
import nodemailer from 'nodemailer';

const SMTP_HOST = 'smtp.gmail.com';

// nodemailer's own hostname resolver ignores the `family` option and instead
// decides IPv4-vs-IPv6 by inspecting the machine's network interfaces; on
// Render's containers that check misreports IPv6 as usable, so it only ever
// tries Gmail's IPv6 address — which Render has no outbound route for
// (ENETUNREACH). Resolving the A record ourselves and passing a literal IP
// as `host` skips that logic entirely (nodemailer treats an IP literal as
// already-resolved). `servername` keeps TLS validating against the real
// hostname despite `host` being an IP.
async function resolveSmtpHost() {
  try {
    const addresses = await dns.promises.resolve4(SMTP_HOST);
    if (addresses[0]) return addresses[0];
  } catch {
    // fall through to the hostname below
  }
  return SMTP_HOST;
}

function buildTransporter(host) {
  return nodemailer.createTransport({
    host,
    servername: SMTP_HOST,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,
  });
}

// Real email delivery — replaces the old in-app-toast "simulated OTP".
// If SMTP isn't configured yet, this throws rather than silently pretending
// to send, so the caller can surface a clear error instead of a fake success.
export async function sendOtpEmail(toEmail, otp, purpose = 'password reset') {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email sending is not configured (SMTP_USER/SMTP_PASS missing).');
  }

  const host = await resolveSmtpHost();
  const transporter = buildTransporter(host);

  await transporter.sendMail({
    from: `"Smaatech HRMS" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Your verification code: ${otp}`,
    text: `Your verification code for ${purpose} is ${otp}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your verification code for <strong>${purpose}</strong> is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${otp}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}
