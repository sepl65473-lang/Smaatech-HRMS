export function generateWelcomeEmail({ userName, role, tempPassword, company = 'Smaatech', portalUrl = 'https://hrms.smaatech.co' }) {
  const subject = `Welcome to ${company} HRMS — Your Account Credentials`;

  const text = `Hello ${userName},

Welcome to ${company}! Your HRMS login profile has been created successfully.

Here are your account login details:
- Portal URL: ${portalUrl}
- Username / Email: ${userName}
- Assigned Role: ${role}
- Temporary Password: ${tempPassword}

IMPORTANT SECURITY NOTICE:
You will be required to change your temporary password immediately upon your first login. Please do not share these credentials with anyone.

If you have any questions, please contact your HR Administrator.

Best regards,
People Operations Team
${company}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background-color: #f4f5f7; color: #1e293b; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { font-size: 20px; font-weight: 700; color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 20px; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 4px; }
    .value { font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 12px; }
    .password-box { font-family: monospace; font-size: 18px; font-weight: 700; letter-spacing: 2px; color: #2563eb; background: #eff6ff; padding: 8px 12px; border-radius: 6px; display: inline-block; }
    .alert-box { background: #fffbe6; border-left: 4px solid #f59e0b; padding: 12px 16px; font-size: 13px; color: #78350f; border-radius: 4px; margin: 20px 0; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 12px; }
    .footer { font-size: 12px; color: #94a3b8; margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${company} HRMS Welcome Portal</div>
    <p>Hello <strong>${userName}</strong>,</p>
    <p>Welcome to <strong>${company}</strong>! Your workspace account has been created.</p>
    
    <div class="card">
      <div class="label">Assigned Role</div>
      <div class="value">${role}</div>
      
      <div class="label">Temporary Password</div>
      <div class="value"><span class="password-box">${tempPassword}</span></div>
    </div>

    <div class="alert-box">
      <strong>Security Requirement:</strong> You will be prompted to set a new password on your first login before accessing the HRMS portal.
    </div>

    <a href="${portalUrl}" class="btn" target="_blank">Sign In to HRMS</a>

    <div class="footer">
      This is an automated system notification from ${company} HRMS.<br>
      Please contact HR Administrator if you have any questions.
    </div>
  </div>
</body>
</html>
`;

  return { subject, text, html };
}
