/**
 * Leave approval eligibility, mirroring server/src/routes/leave.js `canDecide`.
 *
 * This exists because the page used to decide on its own, with a DIFFERENT
 * default stage list and no notion of the reporting relationship, so:
 *   - an employee's actual reporting manager saw no Approve button even though
 *     the server would have accepted their decision;
 *   - HR filing their own leave saw Approve/Decline that the server refuses
 *     with SELF_APPROVAL_FORBIDDEN;
 *   - the "awaiting <role>" caption named the wrong stage entirely.
 *
 * Hiding a button is not authorization — the server decides. This only stops
 * the UI from offering actions that cannot succeed, and from hiding ones that
 * can.
 */

// Same fallback as the server's DEFAULT_STAGES.
export const DEFAULT_STAGES = ['Reporting Manager', 'HR Manager'];

export function stagesFor(leave) {
  return leave?.approvalStages?.length ? leave.approvalStages : DEFAULT_STAGES;
}

export function requiredStageFor(leave) {
  const stages = stagesFor(leave);
  return stages[leave?.currentStage || 0] || stages[stages.length - 1];
}

/**
 * @param leave      the leave request
 * @param currentUser  { role, empId }
 * @param employees  the directory, used to resolve the requester's managerId.
 *                   May be empty for roles that cannot read it, in which case
 *                   the manager-stage check falls back to the HR rule only.
 */
export function canDecideLeave({ leave, currentUser, employees = [] }) {
  if (!leave || leave.status !== 'pending') return false;
  const role = currentUser?.role;
  const me = currentUser?.empId ? String(currentUser.empId) : null;

  // Self-approval is blocked for EVERY role, HR Director included.
  if (me && String(leave.empId) === me) return false;

  const requiredStage = requiredStageFor(leave);

  if (requiredStage === 'Reporting Manager') {
    const requester = employees.find((e) => String(e.id) === String(leave.empId));
    const managerId = requester?.managerId ? String(requester.managerId) : null;
    if (managerId && me && me === managerId) return true;
    // HR is the fallback so a request can never become un-approvable.
    return ['HR Manager', 'HR Director'].includes(role);
  }

  if (role === requiredStage) return true;
  return role === 'HR Director'; // escalation path for every other stage
}
