import Document from '../models/Document.js';
import User from '../models/User.js';
import { sendNotification } from './notificationService.js';
import { processInNonBlockingBatches } from './jobQueue.js';
import logger from './logger.js';

import { connectDB } from '../db.js';

// Checks for documents expiring within 30 days and sends alerts in non-blocking batches.
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
      reminderSent: { $ne: true },
    });

    if (!docs.length) return;

    // Filter documents expiring within 30 days
    const expiringDocs = docs.filter((doc) => {
      const expiry = new Date(doc.expiryDate);
      return !isNaN(expiry.getTime()) && expiry <= thirtyDaysFromNow;
    });

    if (!expiringDocs.length) return;

    // Batch query recipient Users in 1 single query instead of N+1 loop calls
    const ownerIds = [...new Set(expiringDocs.map((d) => d.ownerId).filter(Boolean))];
    const users = ownerIds.length ? await User.find({ employeeId: { $in: ownerIds } }).lean() : [];
    const userByEmpId = new Map(users.map((u) => [String(u.employeeId), u._id]));

    let sentCount = 0;
    await processInNonBlockingBatches(expiringDocs, 50, async (chunk) => {
      await Promise.all(chunk.map(async (doc) => {
        const expiry = new Date(doc.expiryDate);
        const recipientId = doc.ownerId ? userByEmpId.get(String(doc.ownerId)) || null : null;
        const formattedExpiry = expiry.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });

        await sendNotification({
          recipientId,
          title: `Document Expiry Warning: ${doc.title}`,
          message: `The document "${doc.title}" owned by ${doc.owner} is expiring on ${formattedExpiry}. Please update it.`,
          type: 'system',
          actionUrl: '/documents',
          channels: recipientId ? ['in-app', 'email'] : ['in-app'],
          company: doc.company,
        });

        doc.reminderSent = true;
        await doc.save();
        sentCount++;
      }));
    });

    logger.info(`[Document Expiry Job] Finished expiry check. Non-blocking reminded ${sentCount} expiring document(s).`);
  } catch (err) {
    logger.error('[Document Expiry Job Error] %o', err);
  }
}

// Scheduling now lives in lib/jobs.js, behind lib/scheduler.js's
// single-owner guard — see the note in attendanceDailyJob.js.

