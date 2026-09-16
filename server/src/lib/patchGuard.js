/**
 * Field allow-listing for PATCH handlers.
 *
 * Several routes passed `req.body` straight into findByIdAndUpdate /
 * Object.assign. That let any caller who could reach the route set fields the
 * endpoint never meant to expose — most importantly `company` (moving a record
 * into another tenant), `_id`, and workflow fields like `status`,
 * `currentStage` and `approvals` that exist precisely so a decision has to go
 * through the approve/decline routes and their permission checks.
 *
 * Unknown keys are dropped silently rather than rejected, matching how the Joi
 * middleware already behaves elsewhere, so an older client sending an extra
 * field keeps working while the field itself has no effect.
 */

// Never settable through any generic patch, whatever the route's own list says.
const ALWAYS_FORBIDDEN = new Set([
  '_id', 'id', '__v', 'company', 'createdAt', 'updatedAt',
  'approvals', 'currentStage', 'approvalStages',
  'idempotencyKey', 'lockedAt', 'lockedBy', 'tokenVersion', 'passwordHash',
]);

export function pickFields(body, allowed) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;
  for (const field of allowed) {
    if (ALWAYS_FORBIDDEN.has(field)) continue;
    if (body[field] !== undefined) patch[field] = body[field];
  }
  return patch;
}

/** True when the caller is acting on their own record — used to block self-approval. */
export function isSelf(req, ownerEmployeeId) {
  return Boolean(req.auth?.employeeId) && String(req.auth.employeeId) === String(ownerEmployeeId);
}
