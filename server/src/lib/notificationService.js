import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import { sendEmail } from './mailer.js';

// Settings.notifyChannels stores display labels ('In-app','Email','WhatsApp',
// 'SMS'); lower-cased they match the internal channel keys used below.
export function resolveChannels(settingsDoc, category, fallback = ['in-app']) {
  const configured = settingsDoc?.notifyChannels?.[category];
  if (!configured || !configured.length) return fallback;
  return configured.map((c) => String(c).toLowerCase());
}

// Settings.notificationTemplates entries look like "Subject: X\n\nBody..."
// with {placeholder} tokens. Returns null if no template is configured, so
// callers can fall back to their existing hardcoded title/message.
export function fillTemplate(raw, vars = {}) {
  if (!raw || !raw.trim()) return null;
  const subjectMatch = raw.match(/^Subject:\s*(.+?)\r?\n\r?\n/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;
  const body = subjectMatch ? raw.slice(subjectMatch[0].length) : raw;
  const fill = (s) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v ?? ''), s);
  return { subject: subject ? fill(subject) : null, body: fill(body).trim() };
}

export async function sendNotification({ recipientId, title, message, type = 'system', actionUrl = '', channels = ['in-app'], emailOverride = null, company = 'Smaatech' }) {
  try {
    // 1. In-app notification creation
    let dbNotif = null;
    if (channels.includes('in-app')) {
      dbNotif = await Notification.create({
        recipientId,
        title,
        message,
        type,
        actionUrl,
        company,
      });
    }

    // 2. Fetch User & Employee details if we have targeted recipientId
    let recipientUser = null;
    let recipientEmp = null;
    if (recipientId) {
      recipientUser = await User.findById(recipientId);
      if (recipientUser && recipientUser.employeeId) {
        recipientEmp = await Employee.findById(recipientUser.employeeId);
      }
    }

    const emailTo = recipientUser?.email;
    const phoneTo = recipientEmp?.phone || '+91 98765 43210';

    // 3. Process email channel
    if (channels.includes('email') && emailTo) {
      if (process.env.BREVO_API_KEY && process.env.SMTP_USER) {
        const subject = emailOverride?.subject || title;
        const body = emailOverride?.body || message;
        await sendEmail({ to: emailTo, subject, text: body });
        console.log(`[Notification Service] Real email sent to ${emailTo}`);
      } else {
        console.log(`[Notification Service] [Email Scaffolding] (email not configured) to ${emailTo}: "${title}" - "${message}"`);
      }
    }

    // 4. Process SMS channel
    if (channels.includes('sms')) {
      console.log(`[Notification Service] [SMS Scaffolding] Sending SMS to ${phoneTo}: "${message}"`);
    }

    // 5. Process WhatsApp channel
    if (channels.includes('whatsapp')) {
      console.log(`[Notification Service] [WhatsApp Scaffolding] Sending WhatsApp message to ${phoneTo}: "${message}"`);
    }

    // 6. Process Push notification channel
    if (channels.includes('push')) {
      console.log(`[Notification Service] [Push Scaffolding] Sending Push Notification to devices of User ${recipientUser?.name || 'System'}: "${title}" - "${message}"`);
    }

    return dbNotif;
  } catch (err) {
    console.error('[Notification Service Error]', err);
  }
}
