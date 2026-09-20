// The holiday calendar is the same page for everyone, but managing it is
// HR's job: the API already refuses POST/PATCH/DELETE below HR Manager
// (server/src/routes/holidays.js), so the buttons an employee could see only
// ever produced a 403. These pin that an employee sees the calendar and
// nothing that edits it, while HR keeps every control it had.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Holidays from './Holidays';
import { HRMSContext } from '../context/HRMSContext';

// The page shows the CURRENT month by default, so the fixtures have to live
// in it — dates are stored as "12 Sep, Fri" and parsed by parseHolidayDay.
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date().getMonth()];
const HOLIDAYS = [
  { id: 'h1', name: 'Republic Day', date: `12 ${MONTH}, Fri`, type: 'National' },
  { id: 'h2', name: 'Founders Day', date: `18 ${MONTH}, Thu`, type: 'Optional' },
];

function renderAs(role) {
  const value = {
    holidays: HOLIDAYS,
    addHoliday: vi.fn(),
    deleteHoliday: vi.fn(),
    importHolidays: vi.fn(),
    toast: vi.fn(),
    currentUser: { role },
  };
  render(
    <HRMSContext.Provider value={value}>
      <Holidays />
    </HRMSContext.Provider>,
  );
  return value;
}

const MANAGEMENT_CONTROLS = [/add holiday/i, /import csv/i, /export csv/i, /delete/i];

describe('Employee view', () => {
  it('shows the holiday calendar', () => {
    renderAs('Employee');
    expect(screen.getByText('Holiday calendar')).toBeTruthy();
    // Both the calendar grid and the list view render the records themselves.
    expect(screen.getAllByText('Republic Day').length).toBeGreaterThan(0);
    expect(screen.getAllByText('National').length).toBeGreaterThan(0);
  });

  it('offers nothing that creates, edits, imports, exports or deletes', () => {
    renderAs('Employee');
    for (const control of MANAGEMENT_CONTROLS) {
      expect(screen.queryByRole('button', { name: control })).toBeNull();
    }
  });
});

describe('HR view is unchanged', () => {
  it.each(['HR Manager', 'HR Director'])('keeps every control for %s', (role) => {
    renderAs(role);
    for (const control of MANAGEMENT_CONTROLS) {
      expect(screen.getAllByRole('button', { name: control }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Holiday calendar')).toBeTruthy();
  });
});
