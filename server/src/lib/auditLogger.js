import AuditLog from '../models/AuditLog.js';

// Credentials and their hashes never belong in the audit trail. Logging a User
// document used to copy passwordHash/otpHash into before/after/diff and into
// the human-readable details line shown in the activity feed.
const SENSITIVE_KEYS = new Set([
  'password', 'passwordHash', 'otpHash', 'otpExpiresAt',
  'loginOtpHash', 'loginOtpExpiresAt', 'tokens', 'tokenHash',
]);

function withoutSensitive(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  if (typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const copy = { ...obj };
  for (const key of SENSITIVE_KEYS) delete copy[key];
  return copy;
}

function summarizeValue(v) {
  if (v === undefined) return 'undefined';
  if (v !== null && typeof v === 'object') return Array.isArray(v) ? `[${v.length} item(s)]` : '{…}';
  return JSON.stringify(v);
}

export async function logAudit(req, { action, subject, before, after, details = '', actor = null, company = null }) {
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
        if (['createdAt', 'updatedAt', '__v', 'id', '_id'].includes(key) || SENSITIVE_KEYS.has(key)) continue;
        const bVal = beforeObj[key];
        const aVal = afterObj[key];

        if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
          diff[key] = { from: bVal, to: aVal };
          // Full before/after values still land in `diff` above for the audit
          // trail — this is only the short human-readable summary, so object/array
          // values (e.g. device info, face-match verification) are collapsed rather
          // than dumped as raw JSON, which used to blow up the activity feed UI.
          changes.push(`${key}: ${summarizeValue(bVal)} -> ${summarizeValue(aVal)}`);
        }
      }

      if (changes.length > 0 && !details) {
        const shown = changes.slice(0, 5).join(', ');
        const more = changes.length > 5 ? `, +${changes.length - 5} more` : '';
        computedDetails = `${shown}${more}`.slice(0, 300);
      }
    }

    await AuditLog.create({
      actor: actor || (req.auth ? {
        id: req.auth.id,
        name: req.auth.name,
        role: req.auth.role,
      } : { name: 'System', role: 'System' }),
      action,
      subject: subject || '',
      details: computedDetails || '',
      before: withoutSensitive(before),
      after: withoutSensitive(after),
      diff,
      ip,
      userAgent,
      company: company || req.auth?.company || 'Smaatech',
    });
  } catch (err) {
    console.error('[Audit Log Error]', err);
  }
}
