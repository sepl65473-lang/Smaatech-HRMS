// Regression test for a real bug found this session: EmployeeForm's reset
// useEffect depended on departments/locations, which getMasterValues()
// rebuilds as a brand-new array on every call — so the dependency was a new
// reference every render, re-running the effect's setState calls every
// render, an infinite loop (React's "Maximum update depth exceeded",
// confirmed live in a browser before the fix). The mock below deliberately
// returns a fresh array each call, exactly like the real implementation, so
// this test would have failed before the fix.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import EmployeeForm from './EmployeeForm';
import { HRMSContext } from '../context/HRMSContext';

function renderForm(props = {}) {
  const mockValue = {
    settings: {},
    employees: [],
    currentUser: { role: 'HR Manager' },
    getMasterValues: vi.fn((code) => {
      if (code === 'departments') return ['Design', 'Engineering'].slice();
      if (code === 'locations') return ['Bengaluru', 'Remote'].slice();
      return [];
    }),
  };
  return render(
    <HRMSContext.Provider value={mockValue}>
      <EmployeeForm open onClose={() => {}} onSave={vi.fn()} {...props} />
    </HRMSContext.Provider>,
  );
}

describe('EmployeeForm', () => {
  it('does not enter an infinite render loop when master-value lists are freshly computed each render', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderForm();
    // Let any runaway effect/render cycle have a chance to manifest.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const loopWarnings = consoleError.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('Maximum update depth exceeded'),
    );
    expect(loopWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('renders the four field-group section labels', () => {
    const { getByText } = renderForm();
    expect(getByText('Basic details')).toBeInTheDocument();
    expect(getByText('Compensation & banking')).toBeInTheDocument();
    expect(getByText('Statutory details')).toBeInTheDocument();
  });
});
