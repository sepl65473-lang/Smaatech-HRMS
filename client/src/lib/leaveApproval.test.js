import { describe, it, expect } from 'vitest';
import { canDecideLeave, requiredStageFor, DEFAULT_STAGES } from './leaveApproval';

const pending = (over = {}) => ({ id: 'l1', empId: 'e1', status: 'pending', currentStage: 0, ...over });
const employees = [{ id: 'e1', managerId: 'm1' }, { id: 'e2' }];

describe('leave approval eligibility', () => {
  it('uses the same default stages as the server', () => {
    expect(DEFAULT_STAGES).toEqual(['Reporting Manager', 'HR Manager']);
    expect(requiredStageFor(pending())).toBe('Reporting Manager');
  });

  it("lets the requester's OWN reporting manager decide the manager stage", () => {
    expect(canDecideLeave({ leave: pending(), currentUser: { role: 'Employee', empId: 'm1' }, employees })).toBe(true);
  });

  it('does NOT let a manager decide outside their own team', () => {
    expect(canDecideLeave({ leave: pending({ empId: 'e2' }), currentUser: { role: 'Employee', empId: 'm1' }, employees })).toBe(false);
  });

  it('lets HR act as the manager-stage fallback', () => {
    for (const role of ['HR Manager', 'HR Director']) {
      expect(canDecideLeave({ leave: pending(), currentUser: { role, empId: 'hr1' }, employees })).toBe(true);
    }
  });

  it('blocks self-approval for every role', () => {
    for (const role of ['Employee', 'HR Manager', 'HR Director']) {
      expect(canDecideLeave({
        leave: pending({ empId: 'hr1' }), currentUser: { role, empId: 'hr1' }, employees,
      })).toBe(false);
    }
  });

  it('matches the role named by the current stage', () => {
    const l = pending({ currentStage: 1 }); // 'HR Manager'
    expect(canDecideLeave({ leave: l, currentUser: { role: 'HR Manager', empId: 'x' }, employees })).toBe(true);
    expect(canDecideLeave({ leave: l, currentUser: { role: 'Finance Lead', empId: 'x' }, employees })).toBe(false);
    expect(canDecideLeave({ leave: l, currentUser: { role: 'HR Director', empId: 'x' }, employees })).toBe(true);
  });

  it('offers nothing on a request that is no longer pending', () => {
    expect(canDecideLeave({ leave: pending({ status: 'approved' }), currentUser: { role: 'HR Director', empId: 'x' }, employees })).toBe(false);
  });
});
