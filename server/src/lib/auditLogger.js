import AuditLog from '../models/AuditLog.js';

export async function logAudit(req, { action, subject, before, after, details = '' }) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    let diff = null;
    let computedDetails = details;

    if (before && after) {
      diff = {};
      const beforeObj = before.toObject ? before.toObject() : JSON.parse(JSON.stringify(before));
      const afterObj = after.toObject ? after.toObject() : JSON.parse(JSON.stringify(after));

      const changes = [];
      const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

      for (const key of keys) {
        if (['createdAt', 'updatedAt', '__v', 'id', '_id', 'password', 'tokens'].includes(key)) continue;
        const bVal = beforeObj[key];
        const aVal = afterObj[key];

        if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
          diff[key] = { from: bVal, to: aVal };
          const fromStr = bVal !== undefined ? JSON.stringify(bVal) : 'undefined';
          const toStr = aVal !== undefined ? JSON.stringify(aVal) : 'undefined';
          changes.push(`${key}: ${fromStr} -> ${toStr}`);
        }
      }

      if (changes.length > 0 && !details) {
        computedDetails = changes.join(', ');
      }
    }

    await AuditLog.create({
      actor: req.auth ? {
        id: req.auth.id,
        name: req.auth.name,
        role: req.auth.role,
      } : { name: 'System', role: 'System' },
      action,
      subject: subject || '',
      details: computedDetails || '',
      before: before ? (before.toObject ? before.toObject() : before) : null,
      after: after ? (after.toObject ? after.toObject() : after) : null,
      diff,
      ip,
      userAgent,
      company: req.auth?.company || 'Smaatech',
    });
  } catch (err) {
    console.error('[Audit Log Error]', err);
  }
}
