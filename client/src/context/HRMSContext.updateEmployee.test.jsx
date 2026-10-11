// Regression test for a production bug: saving an employee's profile reset
// that employee's attendance to "absent".
//
// updateEmployee() keeps the name and department printed on an employee's
// attendance, payroll and leave rows in step with the profile. It also sent
// `status: 'absent'` (or 'leave') to EVERY loaded attendance row of that
// employee whenever the saved data carried the employee's own status - and
// the edit form always carries it. So changing someone's location or e-mail
// overwrote days they had actually worked: in October 2026 five "late" days
// and one "early-exit" day were turned into "absent" this way, and the
// attendance reports then printed them as absent.
//
// These tests drive the real HRMSProvider and its real updateEmployee; only
// the network layer (data/store) is replaced, and what it is asked to write
// is what gets checked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { todayISO } from '../lib/helpers';

const store = vi.hoisted(() => {
  // Any API method nobody set up answers with an empty list, so the provider
  // can boot without every collection being spelled out here.
  const api = () => new Proxy({}, {
    get(target, key) {
      if (!(key in target)) target[key] = vi.fn(async () => []);
      return target[key];
    },
  });
  const names = [
    'employeesApi', 'leavesApi', 'attendanceApi', 'payrollApi', 'celebrationsApi', 'recruitmentApi',
    'settingsApi', 'holidaysApi', 'reviewsApi', 'expensesApi', 'assetsApi', 'jobsApi', 'authApi', 'faceApi',
    'usersApi', 'rolesApi', 'masterValuesApi', 'auditLogsApi', 'notificationsApi', 'documentsApi',
    'resignationsApi', 'attendanceCorrectionsApi', 'deviceMappingsApi',
  ];
  const mocks = Object.fromEntries(names.map((name) => [name, api()]));
  return {
    ...mocks,
    loadAll: vi.fn(),
    resetDB: vi.fn(),
    reloadFromDisk: vi.fn(),
    DB_STORAGE_KEY: 'hrms-test-db',
  };
});

vi.mock('../data/store', () => store);

const { HRMSProvider, useHRMS } = await import('./HRMSContext');

const TODAY = todayISO();
const EMP = 'emp-1';
const OTHER = 'emp-2';

const employee = (id, extra = {}) => ({
  id, name: 'Asha Rao', dept: 'Engineering', status: 'active', loc: 'Bhubaneswar', email: 'asha@example.test', salary: 50000, ...extra,
});

// One row for every status the HRMS stores, each on its own past day, plus
// today's row and another employee's row.
const attendanceRows = () => [
  { id: 'att-late', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-10-02', checkIn: '09:48', checkOut: '18:08', status: 'late', workedMinutes: 500 },
  { id: 'att-early', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-10-01', checkIn: '10:22', checkOut: '10:22', status: 'early-exit', workedMinutes: 0 },
  { id: 'att-present', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-09-30', checkIn: '08:55', checkOut: '18:05', status: 'present', workedMinutes: 550 },
  { id: 'att-half', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-09-29', checkIn: '09:00', checkOut: '13:00', status: 'half-day', workedMinutes: 240 },
  { id: 'att-absent', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-09-28', checkIn: null, checkOut: null, status: 'absent' },
  { id: 'att-leave', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-09-27', checkIn: null, checkOut: null, status: 'leave' },
  { id: 'att-holiday', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: '2026-09-26', checkIn: null, checkOut: null, status: 'holiday' },
  { id: 'att-today', empId: EMP, name: 'Asha Rao', dept: 'Engineering', date: TODAY, checkIn: '09:10', checkOut: null, status: 'late' },
  { id: 'att-other', empId: OTHER, name: 'Ravi Das', dept: 'Finance', date: '2026-10-02', checkIn: '09:00', checkOut: '18:00', status: 'present' },
];

const ORIGINAL_STATUS = Object.fromEntries(attendanceRows().map((row) => [row.id, row.status]));

let ctx;
function Capture() {
  ctx = useHRMS();
  return null;
}

async function renderProvider({ leaves = [] } = {}) {
  store.loadAll.mockResolvedValue({
    employees: [employee(EMP), employee(OTHER, { name: 'Ravi Das', dept: 'Finance' })],
    leaves,
    attendance: attendanceRows(),
    payroll: [{ id: 'pay-1', empId: EMP, name: 'Asha Rao', dept: 'Engineering', gross: 50000, deductions: 15000, net: 35000, status: 'ready' }],
    celebrations: [], holidays: [], recruitment: [], settings: {},
  });
  render(<HRMSProvider><Capture /></HRMSProvider>);
  await waitFor(() => expect(ctx.attendance).toHaveLength(attendanceRows().length));
}

/** Every attendance write the provider asked the server for, as [rowId, patch]. */
const attendanceWrites = () => store.attendanceApi.update.mock.calls.map(([id, patch]) => [id, patch]);
const statusesInApp = () => Object.fromEntries(ctx.attendance.map((row) => [row.id, row.status]));

beforeEach(() => {
  vi.clearAllMocks();
  ctx = null;
  store.authApi.bootstrap.mockResolvedValue({ id: 'user-1', name: 'HR Admin', role: 'HR Director', email: 'hr@example.test' });
  store.faceApi.status.mockResolvedValue({ enrolled: true });
  store.faceApi.myAccess.mockResolvedValue({ enrolled: true, canEnrol: false, grant: null });
  // The server answers an employee update with the saved employee.
  store.employeesApi.update.mockImplementation(async (id, patch) => ({ ...employee(id), ...patch }));
  store.attendanceApi.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
  store.payrollApi.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
  store.leavesApi.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
});

describe('updateEmployee - saving a profile leaves attendance statuses alone', () => {
  it('an ordinary edit (the form always sends the employee status) writes no attendance status', async () => {
    await renderProvider();
    // Exactly what the edit form submits when HR changes only the location.
    await act(() => ctx.updateEmployee(EMP, { name: 'Asha Rao', dept: 'Engineering', status: 'active', loc: 'Cuttack', email: 'asha@example.test' }));

    expect(store.employeesApi.update).toHaveBeenCalledWith(EMP, expect.objectContaining({ loc: 'Cuttack' }));
    const writes = attendanceWrites();
    expect(writes.length).toBeGreaterThan(0); // the name/department sync still runs
    for (const [id, patch] of writes) {
      expect(patch, `attendance row ${id}`).not.toHaveProperty('status');
      expect(patch, `attendance row ${id}`).not.toHaveProperty('checkIn');
      expect(patch, `attendance row ${id}`).not.toHaveProperty('checkOut');
    }
    // And the app's own copy still shows every day as it was.
    expect(statusesInApp()).toEqual(ORIGINAL_STATUS);
    expect(ctx.attendance.find((row) => row.id === 'att-late')).toMatchObject({ status: 'late', checkIn: '09:48', checkOut: '18:08' });
    expect(ctx.attendance.find((row) => row.id === 'att-early')).toMatchObject({ status: 'early-exit', checkIn: '10:22' });
    expect(ctx.attendance.find((row) => row.id === 'att-present')).toMatchObject({ status: 'present', checkIn: '08:55' });
  });

  it('setting the employee to On leave from the profile does not rewrite attendance to "leave"', async () => {
    await renderProvider();
    await act(() => ctx.updateEmployee(EMP, { name: 'Asha Rao', dept: 'Engineering', status: 'on-leave' }));

    for (const [id, patch] of attendanceWrites()) expect(patch, `attendance row ${id}`).not.toHaveProperty('status');
    expect(statusesInApp()).toEqual(ORIGINAL_STATUS);
    // The profile change itself is saved and shown.
    expect(ctx.employees.find((e) => e.id === EMP).status).toBe('on-leave');
  });

  it('an edit that changes neither name nor department writes nothing to attendance at all', async () => {
    await renderProvider();
    await act(() => ctx.updateEmployee(EMP, { status: 'remote', loc: 'Remote' }));

    expect(store.attendanceApi.update).not.toHaveBeenCalled();
    expect(statusesInApp()).toEqual(ORIGINAL_STATUS);
    expect(ctx.employees.find((e) => e.id === EMP)).toMatchObject({ status: 'remote', loc: 'Remote' });
  });

  it('still keeps name and department in step on that employee\'s rows only, and salary on payroll', async () => {
    await renderProvider();
    await act(() => ctx.updateEmployee(EMP, { name: 'Asha R. Rao', dept: 'Operations', status: 'active', salary: 60000 }));

    const writes = attendanceWrites();
    expect(writes.map(([id]) => id).sort()).toEqual(attendanceRows().filter((row) => row.empId === EMP).map((row) => row.id).sort());
    for (const [, patch] of writes) expect(patch).toEqual({ name: 'Asha R. Rao', dept: 'Operations' });

    expect(ctx.attendance.find((row) => row.id === 'att-late')).toMatchObject({ name: 'Asha R. Rao', dept: 'Operations', status: 'late' });
    expect(ctx.attendance.find((row) => row.id === 'att-other')).toMatchObject({ name: 'Ravi Das', dept: 'Finance', status: 'present' });
    expect(ctx.employees.find((e) => e.id === EMP)).toMatchObject({ name: 'Asha R. Rao', dept: 'Operations' });
    expect(store.payrollApi.update).toHaveBeenCalledWith('pay-1', { name: 'Asha R. Rao', dept: 'Operations', gross: 60000, deductions: 18000, net: 42000 });
  });
});

describe('leave approval - the dedicated leave workflow is unchanged', () => {
  it('approving a leave that covers today still marks only today\'s row as leave', async () => {
    const leave = { id: 'leave-1', empId: EMP, name: 'Asha Rao', start: TODAY, end: TODAY, status: 'pending' };
    store.leavesApi.approve.mockResolvedValue({ ...leave, status: 'approved' });
    await renderProvider({ leaves: [leave] });
    await act(() => ctx.approveLeave('leave-1'));

    expect(attendanceWrites()).toEqual([['att-today', { status: 'leave', checkIn: null, checkOut: null }]]);
    expect(store.employeesApi.update).toHaveBeenCalledWith(EMP, { status: 'on-leave' });
    // Every other day keeps the status it had.
    const { 'att-today': today, ...rest } = statusesInApp();
    const { 'att-today': _was, ...restOriginal } = ORIGINAL_STATUS;
    expect(today).toBe('leave');
    expect(rest).toEqual(restOriginal);
  });
});
