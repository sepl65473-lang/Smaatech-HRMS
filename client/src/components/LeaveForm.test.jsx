// Regression test for the identical infinite-loop bug fixed in
// EmployeeForm.test.jsx: LeaveForm's reset useEffect depended on `leaveTypes`,
// rebuilt fresh from getMasterValues() on every render.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import LeaveForm from './LeaveForm';
import { HRMSContext } from '../context/HRMSContext';

function renderForm(props = {}) {
  const mockValue = {
    getMasterValues: vi.fn((code) => {
      if (code === 'leave_types') return ['casual', 'sick'].slice();
      return [];
    }),
  };
  const employees = [{ id: 'emp1', name: 'Test Employee' }];
  return render(
    <HRMSContext.Provider value={mockValue}>
      <LeaveForm open employees={employees} onClose={() => {}} onSave={vi.fn()} {...props} />
    </HRMSContext.Provider>,
  );
}

describe('LeaveForm', () => {
  it('does not enter an infinite render loop when leave-type list is freshly computed each render', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderForm();
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const loopWarnings = consoleError.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('Maximum update depth exceeded'),
    );
    expect(loopWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });
});
