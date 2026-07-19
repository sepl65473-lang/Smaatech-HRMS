import cron from 'node-cron';
import Document from '../models/Document.js';
import User from '../models/User.js';
import { sendNotification } from './notificationService.js';
import logger from './logger.js';

import { connectDB } from '../db.js';

// Checks for documents expiring within 30 days and sends alerts.
export async function checkDocumentExpirations() {
  try {
    await connectDB();
    logger.info('[Document Expiry Job] Running document expiry check...');
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(now.getDate() + 30);

    // Find documents with expiryDate that have not been notified yet
    const docs = await Document.find({
      expiryDate: { $ne: '' },
      reminderSent: { $ne: true }
    });

    let sentCount = 0;
    for (const doc of docs) {
      const expiry = new Date(doc.expiryDate);
      // Validate date
      if (isNaN(expiry.getTime())) continue;

      // Check if it expires within 30 days
      if (expiry <= thirtyDaysFromNow) {
        // Find recipient user account (either by ownerId or email match)
        let recipientId = null;
        if (doc.ownerId) {
          const user = await User.findOne({ employeeId: doc.ownerId });
          if (user) recipientId = user._id;
        }

        const formattedExpiry = expiry.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        });

        // Send notification
        await sendNotification({
          recipientId,
          title: `Document Expiry Warning: ${doc.title}`,
          message: `The document "${doc.title}" owned by ${doc.owner} is expiring on ${formattedExpiry}. Please update it.`,
          type: 'system',
          actionUrl: '/documents',
          channels: recipientId ? ['in-app', 'email'] : ['in-app'],
          company: doc.company
        });

        doc.reminderSent = true;
        await doc.save();
        sentCount++;
      }
    }
    logger.info(`[Document Expiry Job] Finished expiry check. Reminded ${sentCount} expiring documents.`);
  } catch (err) {
    logger.error('[Document Expiry Job Error] %o', err);
  }
}

export function startDocumentExpiryScheduler() {
  // Run on startup (5 second delay to let DB connect and server boot completely)
  setTimeout(() => {
    checkDocumentExpirations().catch((err) => logger.error('[Document Expiry Job Startup Error] %o', err));
  }, 5000);

  // Run daily at midnight (12:00 AM) using node-cron
  cron.schedule('0 0 * * *', () => {
    checkDocumentExpirations().catch((err) => logger.error('[Document Expiry Job Cron Error] %o', err));
  });
}

