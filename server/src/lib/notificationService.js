import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import nodemailer from 'nodemailer';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export async function sendNotification({ recipientId, title, message, type = 'system', actionUrl = '', channels = ['in-app'], company = 'Smaatech' }) {
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
      const transport = getTransporter();
      if (transport) {
        await transport.sendMail({
          from: `"Smaatech HRMS" <${process.env.SMTP_USER}>`,
          to: emailTo,
          subject: title,
          text: message,
          html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
        });
        console.log(`[Notification Service] Real email sent to ${emailTo}`);
      } else {
        console.log(`[Notification Service] [Email Scaffolding] (SMTP not configured) to ${emailTo}: "${title}" - "${message}"`);
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
