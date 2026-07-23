import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    family: 4,
    connectionTimeout: 8000,
  });
  return transporter;
}

// Real email delivery — replaces the old in-app-toast "simulated OTP".
// If SMTP isn't configured yet, this throws rather than silently pretending
// to send, so the caller can surface a clear error instead of a fake success.
export async function sendOtpEmail(toEmail, otp, purpose = 'password reset') {
  const t = getTransporter();
  if (!t) throw new Error('Email sending is not configured (SMTP_USER/SMTP_PASS missing).');

  await t.sendMail({
    from: `"Smaatech HRMS" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Your verification code: ${otp}`,
    text: `Your verification code for ${purpose} is ${otp}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your verification code for <strong>${purpose}</strong> is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${otp}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}
