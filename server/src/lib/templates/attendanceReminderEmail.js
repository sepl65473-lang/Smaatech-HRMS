// Emails for the same-day attendance reminders (lib/attendanceReminderJob.js).
// Sent to one employee about their own attendance only.

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// "2026-09-30" -> "Wednesday, 30 September 2026". The ISO string is already
// the IST calendar date, so it is formatted in UTC to avoid shifting it again.
export function formatReminderDate(dateISO) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${dateISO}T00:00:00Z`));
}

const COPY = {
  'missing-checkin': {
    action: 'Check-In',
    subject: (date) => `Action required: Today's Check-In is missing (${date})`,
    notice: 'Your Check-In for today has not been recorded in the HRMS.',
    instruction: 'If you are working today, please sign in to the HRMS and complete your Check-In now.',
  },
  'missing-checkout': {
    action: 'Check-Out',
    subject: (date) => `Action required: Today's Check-Out is missing (${date})`,
    notice: 'You checked in today, but your Check-Out has not been recorded in the HRMS.',
    instruction: 'Please sign in to the HRMS and complete your Check-Out. If you have already left, submit an attendance correction so your day is recorded accurately.',
  },
};

export function generateAttendanceReminderEmail({ event, employeeName, dateISO, checkIn = null, orgName = 'Smaatech', portalUrl = null }) {
  const copy = COPY[event];
  if (!copy) throw new Error(`Unknown attendance reminder event: ${event}`);

  const displayDate = formatReminderDate(dateISO);
  const subject = copy.subject(displayDate);
  const checkInLine = event === 'missing-checkout' && checkIn ? `Check-In recorded at: ${checkIn}` : null;

  const text = [
    `Dear ${employeeName},`,
    '',
    copy.notice,
    '',
    `Date: ${displayDate}`,
    ...(checkInLine ? [checkInLine] : []),
    `${copy.action}: Not recorded`,
    '',
    copy.instruction,
    ...(portalUrl ? ['', `HRMS portal: ${portalUrl}`] : []),
    '',
    'If you are on approved leave or believe this message was sent in error, please contact your HR team.',
    '',
    'Regards,',
    'People Operations Team',
    `${orgName} HRMS`,
    '',
    'This is an automated message. Please do not reply to this email.',
  ].join('\n');

  const name = escapeHtml(employeeName);
  const org = escapeHtml(orgName);
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background-color: #f4f5f7; color: #1e293b; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; }
    .header { font-size: 20px; font-weight: 700; color: #0f172a; border-bottom: 2px solid #f59e0b; padding-bottom: 12px; margin-bottom: 20px; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 4px; }
    .value { font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 12px; }
    .missing { color: #b45309; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 4px; }
    .footer { font-size: 12px; color: #94a3b8; margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${escapeHtml(copy.action)} Not Recorded</div>
    <p>Dear <strong>${name}</strong>,</p>
    <p>${escapeHtml(copy.notice)}</p>
    <div class="card">
      <div class="label">Date</div>
      <div class="value">${escapeHtml(displayDate)}</div>
      ${checkInLine ? `<div class="label">Check-In</div><div class="value">${escapeHtml(checkIn)}</div>` : ''}
      <div class="label">${escapeHtml(copy.action)}</div>
      <div class="value missing">Not recorded</div>
    </div>
    <p>${escapeHtml(copy.instruction)}</p>
    ${portalUrl ? `<p><a class="btn" href="${escapeHtml(portalUrl)}">Open HRMS</a></p>` : ''}
    <p>If you are on approved leave or believe this message was sent in error, please contact your HR team.</p>
    <p>Regards,<br>People Operations Team<br>${org} HRMS</p>
    <div class="footer">This is an automated message from ${org} HRMS. Please do not reply to this email.</div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}
