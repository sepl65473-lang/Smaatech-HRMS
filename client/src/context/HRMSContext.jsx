import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import {
  loadAll, resetDB, reloadFromDisk, DB_STORAGE_KEY,
  employeesApi, leavesApi, attendanceApi, payrollApi,
  celebrationsApi, recruitmentApi, settingsApi, holidaysApi, reviewsApi,
  expensesApi, assetsApi, jobsApi, authApi, geofenceApi, faceApi, usersApi,
} from '../data/store';
import { setAccessToken } from '../lib/apiClient';
import { getDeviceId } from '../lib/deviceId';
import { uid, daysBetween, todayISO } from '../lib/helpers';
import { resolveShiftForToday, isLate as isLateForShift } from '../lib/shifts';

const GEOFENCE_KEYS = ['gpsCheckInEnabled', 'geofenceLat', 'geofenceLng', 'geofenceRadius', 'shifts', 'roster', 'employeeShifts'];

const HRMSContext = createContext(null);
const AUDIT_KEY = 'Smaatech_hrms_audit_log';

const loadAuditLog = () => {
  try {
    return JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
  } catch {
    return [];
  }
};

export const useHRMS = () => {
  const ctx = useContext(HRMSContext);
  if (!ctx) throw new Error('useHRMS must be used inside <HRMSProvider>');
  return ctx;
};

export function HRMSProvider({ children }) {
  // `booting` covers the brief silent-refresh check on page load (do we have
  // a still-valid httpOnly session cookie?) — kept separate from `loading`
  // (which covers loading app data once authenticated) so the login screen
  // doesn't flash on every refresh before that check resolves.
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(true);
  const [authUser, setAuthUser] = useState(null);
  const [faceEnrolled, setFaceEnrolled] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [payroll, setPayroll] = useState([]);
  const [celebrations, setCelebrations] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [recruitment, setRecruitment] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [assets, setAssets] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState({});
  // Real login accounts (HR Director only) — lazily loaded from the Settings
  // page, not part of hydrate()/loadAll() (see usersApi in data/store.js).
  const [users, setUsers] = useState([]);
  const currentUser = useMemo(() => (authUser ? {
    id: authUser.id,
    name: authUser.name,
    role: authUser.role,
    initials: authUser.initials,
    empId: authUser.employeeId || null,
  } : { name: '', role: '', initials: '' }), [authUser]);
  const [auditLog, setAuditLog] = useState(loadAuditLog);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => Date.now());

  const [toasts, setToasts] = useState([]);
  const [search, setSearch] = useState('');

  // ── Toasts ─────────────────────────────────────────────────
  const dismissToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((type, msg, duration = 3200) => {
    const id = uid('toast');
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => dismissToast(id), duration);
    return id;
  }, [dismissToast]);

  const audit = useCallback((action, subject, details = '') => {
    const entry = {
      id: uid('audit'),
      action,
      subject,
      details,
      actor: currentUser?.name || 'System',
      role: currentUser?.role || '',
      at: new Date().toISOString(),
    };
    setAuditLog((list) => {
      const next = [entry, ...list].slice(0, 80);
      localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
      return next;
    });
    return entry;
  }, [currentUser?.name, currentUser?.role]);

  // ── Initial load ───────────────────────────────────────────
  const hydrate = useCallback((all) => {
    setEmployees(all.employees);
    setLeaves(all.leaves);
    setAttendance(all.attendance);
    setPayroll(all.payroll);
    setCelebrations(all.celebrations);
    setHolidays(all.holidays);
    setRecruitment(all.recruitment);
    setReviews(all.reviews || []);
    setExpenses(all.expenses || []);
    setAssets(all.assets || []);
    setJobs(all.jobs || []);
    setSettings(all.settings);
    setLastSyncedAt(Date.now());
  }, []);

  const loadAuthenticatedData = useCallback(async (userId) => {
    setLoading(true);
    try {
      const [all, faceStatus] = await Promise.all([loadAll(), faceApi.status(userId)]);
      hydrate(all);
      setFaceEnrolled(faceStatus.enrolled);
    } finally {
      // Always clear the loading gate — even on failure — so a flaky request
      // can't leave Layout.jsx stuck on "Loading workspace…" forever.
      setLoading(false);
    }
  }, [hydrate]);

  // Auth is now a real server session (JWT access token in memory + httpOnly
  // refresh cookie — see src/lib/apiClient.js) rather than a plain object
  // trusted from localStorage. `login`/`loginWithFace` return the token
  // instead of committing it immediately so a (still-simulated) 2FA step can
  // gate when the session actually takes effect, same as before.
  const login = useCallback(async (email, password) => {
    const { accessToken, user } = await authApi.login(email, password);
    return { accessToken, user, requiresTwoFactor: Boolean(settings.twoFactor) };
  }, [settings.twoFactor]);

  const loginWithFace = useCallback(async (email) => {
    const { accessToken, user } = await authApi.faceLogin(email);
    return { accessToken, user, requiresTwoFactor: Boolean(settings.twoFactor) };
  }, [settings.twoFactor]);

  const finishLogin = useCallback(async (accessToken, user) => {
    setAccessToken(accessToken);
    setAuthUser(user);
    try {
      await loadAuthenticatedData(user.id);
      toast('success', `Welcome back, <strong>${user.name.split(' ')[0]}</strong>`);
    } catch {
      // The session itself is valid (setAuthUser already ran) — only the
      // initial data fetch failed, so let the user retry instead of hanging.
      toast('error', 'Signed in, but some data failed to load — try refreshing the page.');
    }
  }, [loadAuthenticatedData, toast]);

  const logout = useCallback(async () => {
    await authApi.logout();
    setAuthUser(null);
    setEmployees([]);
    setAttendance([]);
    setFaceEnrolled(false);
    toast('info', 'Signed out');
  }, [toast]);

  const forgotPassword = useCallback((email) => authApi.forgotPassword(email), []);
  const resetPassword = useCallback((email, otp, newPassword) => authApi.resetPassword(email, otp, newPassword), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const user = await authApi.bootstrap();
      if (!alive) return;
      if (user) {
        setAuthUser(user);
        await loadAuthenticatedData(user.id);
      } else {
        setLoading(false);
      }
      if (alive) setBooting(false);
    })();
    return () => { alive = false; };
    // Intentionally runs once on mount only — loadAuthenticatedData is stable
    // across the app's lifetime for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Same-browser live sync ──────────────────────────────────
  // The `storage` event fires in OTHER tabs/windows of the same browser
  // whenever the local (non-backend) collections change, so re-hydrating on
  // it keeps tabs of the same browser in sync. Employees/Attendance are
  // refetched from the server either way (see reloadFromDisk in data/store.js).
  useEffect(() => {
    if (!authUser) return undefined;
    const handler = (e) => {
      if (e.key !== null && e.key !== DB_STORAGE_KEY) return;
      reloadFromDisk().then(hydrate);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [authUser, hydrate]);

  // ════════════════════════════════════════════════════════════
  //  EMPLOYEES — CRUD
  // ════════════════════════════════════════════════════════════
  const addEmployee = async (data, { silent = false } = {}) => {
    const created = await employeesApi.create(data);
    const gross = Number(created.salary || 0);
    const deductions = Math.round(gross * 0.30);
    const [attendanceRow, payrollRow] = await Promise.all([
      attendanceApi.create({
        empId: created.id,
        name: created.name,
        dept: created.dept,
        date: todayISO(),
        checkIn: null,
        checkOut: null,
        status: created.status === 'on-leave' ? 'leave' : 'absent',
      }),
      payrollApi.create({
        empId: created.id,
        name: created.name,
        dept: created.dept,
        gross,
        deductions,
        net: gross - deductions,
        status: 'ready',
        cycle: new Date().toISOString().slice(0, 7),
      }),
    ]);
    setEmployees((list) => [created, ...list]);
    setAttendance((list) => [attendanceRow, ...list]);
    setPayroll((list) => [payrollRow, ...list]);
    audit('Employee added', created.name, created.dept);
    if (!silent) toast('success', `<strong>${created.name}</strong> added to the team`);
    return created;
  };

  const updateEmployee = async (id, patch) => {
    const updated = await employeesApi.update(id, patch);
    const linkedPatch = {
      ...(patch.name != null ? { name: updated.name } : {}),
      ...(patch.dept != null ? { dept: updated.dept } : {}),
    };
    const attendancePatch = {
      ...linkedPatch,
      ...(patch.status != null ? { status: updated.status === 'on-leave' ? 'leave' : 'absent' } : {}),
    };
    const gross = Number(updated.salary || 0);
    const payrollPatch = {
      ...linkedPatch,
      ...(patch.salary != null ? {
        gross,
        deductions: Math.round(gross * 0.30),
        net: gross - Math.round(gross * 0.30),
      } : {}),
    };
    const linkedAttendance = attendance.filter((a) => a.empId === id);
    const linkedPayroll = payroll.filter((p) => p.empId === id);
    const linkedLeaves = leaves.filter((l) => l.empId === id);
    await Promise.all([
      ...linkedAttendance.map((a) => Object.keys(attendancePatch).length ? attendanceApi.update(a.id, attendancePatch) : null),
      ...linkedPayroll.map((p) => Object.keys(payrollPatch).length ? payrollApi.update(p.id, payrollPatch) : null),
      ...linkedLeaves.map((l) => Object.keys(linkedPatch).length ? leavesApi.update(l.id, linkedPatch) : null),
    ].filter(Boolean));
    setEmployees((list) => list.map((e) => (e.id === id ? updated : e)));
    if (Object.keys(attendancePatch).length) {
      setAttendance((list) => list.map((a) => (a.empId === id ? { ...a, ...attendancePatch } : a)));
    }
    if (Object.keys(payrollPatch).length) {
      setPayroll((list) => list.map((p) => (p.empId === id ? { ...p, ...payrollPatch } : p)));
    }
    if (Object.keys(linkedPatch).length) {
      setLeaves((list) => list.map((l) => (l.empId === id ? { ...l, ...linkedPatch } : l)));
    }
    audit('Employee updated', updated.name, updated.dept);
    toast('success', `<strong>${updated.name}</strong> updated`);
    return updated;
  };

  const deleteEmployee = async (id) => {
    const emp = employees.find((e) => e.id === id);
    const linkedAttendance = attendance.filter((a) => a.empId === id);
    const linkedPayroll = payroll.filter((p) => p.empId === id);
    const linkedLeaves = leaves.filter((l) => l.empId === id);
    const linkedReviews = reviews.filter((r) => r.empId === id);
    const directReports = employees.filter((e) => e.managerId === id);
    await Promise.all([
      employeesApi.remove(id),
      ...linkedAttendance.map((a) => attendanceApi.remove(a.id)),
      ...linkedPayroll.map((p) => payrollApi.remove(p.id)),
      ...linkedLeaves.map((l) => leavesApi.remove(l.id)),
      ...linkedReviews.map((r) => reviewsApi.remove(r.id)),
      ...directReports.map((e) => employeesApi.update(e.id, { managerId: null })),
    ]);
    setEmployees((list) => list
      .filter((e) => e.id !== id)
      .map((e) => (e.managerId === id ? { ...e, managerId: null } : e)));
    setAttendance((list) => list.filter((a) => a.empId !== id));
    setPayroll((list) => list.filter((p) => p.empId !== id));
    setLeaves((list) => list.filter((l) => l.empId !== id));
    setReviews((list) => list.filter((r) => r.empId !== id));
    // Any real login account linked to this employee self-heals its dangling
    // employeeId on next login/refresh/me (see sanitizeEmployeeLink in
    // server/src/routes/auth.js) — no client-side cleanup needed here.

    audit('Employee removed', emp ? emp.name : id, 'Linked records removed');
    toast('info', `<strong>${emp ? emp.name : 'Employee'}</strong> removed`);
  };

  const importEmployees = async (rows) => {
    let count = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await addEmployee(row, { silent: true });
      count += 1;
    }
    audit('Employees imported', `${count} rows`, 'CSV import');
    toast('success', `Imported <strong>${count}</strong> employee${count === 1 ? '' : 's'}`);
    return count;
  };

  // ════════════════════════════════════════════════════════════
  //  USERS — real login accounts (HR Director only)
  // ════════════════════════════════════════════════════════════
  const loadUsers = useCallback(async () => {
    const rows = await usersApi.list();
    setUsers(rows);
    return rows;
  }, []);

  const addUserAccount = async (data) => {
    const created = await usersApi.create(data);
    setUsers((list) => [created, ...list]);
    audit('Login created', created.name, created.email);
    toast('success', `Login created for <strong>${created.name}</strong>`);
    return created;
  };

  const updateUserAccount = async (id, patch) => {
    const updated = await usersApi.update(id, patch);
    setUsers((list) => list.map((u) => (u.id === id ? updated : u)));
    audit('Login updated', updated.name, updated.email);
    toast('success', `<strong>${updated.name}</strong>'s login updated`);
    return updated;
  };

  const deleteUserAccount = async (id) => {
    const user = users.find((u) => u.id === id);
    await usersApi.remove(id);
    setUsers((list) => list.filter((u) => u.id !== id));
    audit('Login removed', user ? user.name : id);
    toast('info', `<strong>${user ? user.name : 'Login'}</strong> removed`);
  };

  // ════════════════════════════════════════════════════════════
  //  LEAVE — CRUD + approve / decline
  // ════════════════════════════════════════════════════════════
  const addLeave = async (data) => {
    const emp = employees.find((e) => e.id === data.empId);
    const record = {
      empId: data.empId,
      name: emp ? emp.name : data.name,
      dept: emp ? emp.dept : '—',
      type: data.type,
      start: data.start,
      end: data.end,
      reason: data.reason || '',
      status: 'pending',
    };
    const created = await leavesApi.create(record);
    setLeaves((list) => [created, ...list]);
    audit('Leave requested', created.name, `${created.type} leave`);
    toast('success', `Leave request raised for <strong>${created.name}</strong>`);
    return created;
  };

  const setLeaveStatus = async (id, status) => {
    const updated = await leavesApi.update(id, { status });
    setLeaves((list) => list.map((l) => (l.id === id ? updated : l)));
    if (status === 'approved' && updated.empId) {
      const today = todayISO();
      const activeToday = updated.start <= today && updated.end >= today;
      const linkedAttendance = attendance.filter((a) => a.empId === updated.empId && a.date === today);
      await Promise.all([
        activeToday ? employeesApi.update(updated.empId, { status: 'on-leave' }) : null,
        ...linkedAttendance.map((a) => attendanceApi.update(a.id, { status: 'leave', checkIn: null, checkOut: null })),
      ].filter(Boolean));
      if (activeToday) {
        setEmployees((list) => list.map((e) => (e.id === updated.empId ? { ...e, status: 'on-leave' } : e)));
      }
      if (linkedAttendance.length) {
        setAttendance((list) => list.map((a) => (
          a.empId === updated.empId && a.date === today
            ? { ...a, status: 'leave', checkIn: null, checkOut: null }
            : a
        )));
      }
    }
    toast(status === 'approved' ? 'success' : 'info',
      `Leave <strong>${status}</strong> for ${updated.name}`);
    audit(`Leave ${status}`, updated.name, `${updated.start} to ${updated.end}`);
    return updated;
  };
  const approveLeave = (id) => setLeaveStatus(id, 'approved');
  const declineLeave = (id) => setLeaveStatus(id, 'declined');

  const deleteLeave = async (id) => {
    await leavesApi.remove(id);
    setLeaves((list) => list.filter((l) => l.id !== id));
    audit('Leave deleted', id);
    toast('info', 'Leave request deleted');
  };

  // ════════════════════════════════════════════════════════════
  //  ATTENDANCE — check-in / check-out / status
  // ════════════════════════════════════════════════════════════
  const nowTime = () =>
    new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Check-in/out no longer compose the patch (time/late/geofence) client-side
  // — every fact that matters is re-derived server-side from data the server
  // itself holds (server/src/routes/attendance.js), so a modified client
  // can't just assert `faceVerified: true` or a fabricated GPS distance.
  // `locationData` here is only ever the raw, unverified inputs.
  // `locationData.photo`, when present (a captured selfie Blob), makes this
  // a multipart request — the server re-detects and re-matches the face in
  // that photo itself rather than trusting any client-reported result.
  const buildPunchPayload = (locationData) => {
    if (locationData?.photo) {
      const form = new FormData();
      if (locationData.lat != null) form.append('lat', locationData.lat);
      if (locationData.lng != null) form.append('lng', locationData.lng);
      if (locationData.accuracy != null) form.append('accuracy', locationData.accuracy);
      if (locationData.timestamp != null) form.append('timestamp', locationData.timestamp);
      form.append('deviceId', getDeviceId());
      form.append('photo', locationData.photo, 'checkin.jpg');
      return form;
    }
    return {
      lat: locationData?.lat, lng: locationData?.lng,
      accuracy: locationData?.accuracy, timestamp: locationData?.timestamp,
      deviceId: getDeviceId(),
    };
  };

  const checkIn = async (id, locationData = null) => {
    let updated;
    try {
      updated = await attendanceApi.checkIn(id, buildPunchPayload(locationData));
    } catch (err) {
      toast('error', err.message || 'Check-in failed.');
      throw err;
    }
    setAttendance((list) => list.map((a) => (a.id === id ? updated : a)));
    audit('Attendance check-in', updated.name, `${updated.checkIn}${updated.checkInDetails ? ` (${updated.checkInDetails}${updated.checkInLoc ? `: ${updated.checkInLoc}` : ''})` : ''}`);
    toast('success', `<strong>${updated.name}</strong> checked in · ${updated.checkIn}`);
    return updated;
  };

  const checkOut = async (id, locationData = null) => {
    let updated;
    try {
      updated = await attendanceApi.checkOut(id, buildPunchPayload(locationData));
    } catch (err) {
      toast('error', err.message || 'Check-out failed.');
      throw err;
    }
    setAttendance((list) => list.map((a) => (a.id === id ? updated : a)));
    audit('Attendance check-out', updated.name, `${updated.checkOut}${updated.checkOutDetails ? ` (${updated.checkOutDetails}${updated.checkOutLoc ? `: ${updated.checkOutLoc}` : ''})` : ''}`);
    toast('info', `<strong>${updated.name}</strong> checked out · ${updated.checkOut}`);
    return updated;
  };

  // Uploads a captured selfie for server-side enrollment — the server
  // computes and stores the 128-d descriptor itself; the client never
  // computes or transmits one. `targetUserId` lets HR enroll on behalf of
  // another account (Settings > Users); omitted, it enrolls the caller.
  const enrollFace = async (photoBlob, targetUserId) => {
    const result = await faceApi.enroll(photoBlob, targetUserId);
    if (!targetUserId || targetUserId === currentUser.id) setFaceEnrolled(true);
    toast('success', `Face enrolled for <strong>${result.enrolledFor}</strong>`);
    return result;
  };

  // Used by the biometric-device reconciliation flow (Integrations page):
  // applies a punch time to today's attendance row for an employee.
  const recordPunch = async (empId, time, type) => {
    const today = todayISO();
    const row = attendance.find((a) => a.empId === empId && a.date === today);
    if (!row) return null;
    const patch = type === 'in'
      ? { checkIn: time, status: isLateForShift(time, resolveShiftForToday(empId, settings)) ? 'late' : 'present' }
      : { checkOut: time };
    const updated = await attendanceApi.update(row.id, patch);
    setAttendance((list) => list.map((a) => (a.id === row.id ? updated : a)));
    audit('Biometric punch reconciled', updated.name, `${type === 'in' ? 'Check-in' : 'Check-out'} ${time}`);
    return updated;
  };

  const setAttendanceStatus = async (id, status) => {
    const row = attendance.find((a) => a.id === id);
    const patch = {
      status,
      ...(status === 'absent' || status === 'leave' ? { checkIn: null, checkOut: null } : {}),
      ...((status === 'present' || status === 'late') && !row?.checkIn ? { checkIn: nowTime() } : {}),
    };
    const updated = await attendanceApi.update(id, patch);
    setAttendance((list) => list.map((a) => (a.id === id ? updated : a)));
    audit('Attendance override', updated.name, status);
    toast('info', `<strong>${updated.name}</strong> marked ${status}`);
  };

  // ════════════════════════════════════════════════════════════
  //  PAYROLL — process / mark paid
  // ════════════════════════════════════════════════════════════
  const processPayroll = async () => {
    const ready = payroll.filter((p) => p.status === 'ready');
    await Promise.all(ready.map((p) => payrollApi.update(p.id, { status: 'paid' })));
    setPayroll((list) => list.map((p) => (p.status === 'ready' ? { ...p, status: 'paid' } : p)));
    audit('Payroll processed', `${ready.length} employees`, new Date().toISOString().slice(0, 10));
    toast('success', `Payroll processed for <strong>${ready.length}</strong> employees`);
  };

  // Salary structure: earning/deduction components + LOP proration.
  // Per-day rate uses a fixed 30-day basis, consistently applied for LOP.
  const updatePayrollStructure = async (id, { earnings, deductions, lopDays = 0 }) => {
    const gross = earnings.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const ded = deductions.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const lopAmount = Math.round((gross / 30) * Number(lopDays || 0));
    const net = gross - ded - lopAmount;
    const updated = await payrollApi.update(id, {
      gross, deductions: ded, net,
      lopDays: Number(lopDays || 0), lopAmount,
      components: { earnings, deductions },
    });
    setPayroll((list) => list.map((p) => (p.id === id ? updated : p)));
    audit('Salary structure updated', updated.name, updated.cycle);
    toast('success', `Salary structure updated for <strong>${updated.name}</strong>`);
    return updated;
  };

  const markPaid = async (id) => {
    const updated = await payrollApi.update(id, { status: 'paid' });
    setPayroll((list) => list.map((p) => (p.id === id ? updated : p)));
    audit('Payslip marked paid', updated.name, updated.cycle);
    toast('success', `Slip paid for <strong>${updated.name}</strong>`);
  };

  // ════════════════════════════════════════════════════════════
  //  CELEBRATIONS — send wish
  // ════════════════════════════════════════════════════════════
  const sendWish = async (id, message) => {
    const updated = await celebrationsApi.update(id, { wished: true });
    setCelebrations((list) => list.map((c) => (c.id === id ? updated : c)));
    const count = (settings.wishesSent || 0) + 1;
    const s = await settingsApi.update({ wishesSent: count });
    setSettings(s);
    toast('success', `Wish sent to <strong>${updated.name}</strong>${message ? ' 🎉' : ''}`);
  };

  // ════════════════════════════════════════════════════════════
  //  RECRUITMENT — move stage / add / delete
  // ════════════════════════════════════════════════════════════
  const ONBOARDING_TEMPLATE = [
    'Offer letter signed',
    'Background verification',
    'Documents collected (ID, address, education)',
    'IT account & laptop setup',
    'Added to payroll',
    'Induction scheduled',
  ];

  const moveCandidate = async (id, stage, extra = {}) => {
    const candidate = recruitment.find((c) => c.id === id);
    const patch = { stage, ...extra };
    if (stage === 'Hired' && !candidate?.onboarding) {
      patch.onboarding = ONBOARDING_TEMPLATE.map((label, i) => ({ id: `ob_${i}`, label, done: false }));
    }
    const updated = await recruitmentApi.update(id, patch);
    setRecruitment((list) => list.map((c) => (c.id === id ? updated : c)));
    audit('Candidate moved', updated.candidate, stage);
    toast('info', `<strong>${updated.candidate}</strong> → ${stage}`);
  };

  const toggleOnboardingItem = async (id, itemId) => {
    const candidate = recruitment.find((c) => c.id === id);
    if (!candidate?.onboarding) return;
    const onboarding = candidate.onboarding.map((item) => (
      item.id === itemId ? { ...item, done: !item.done } : item
    ));
    const updated = await recruitmentApi.update(id, { onboarding });
    setRecruitment((list) => list.map((c) => (c.id === id ? updated : c)));
  };

  const addCandidate = async (data) => {
    const created = await recruitmentApi.create({ stage: 'Applied', meta: 'just now', ...data });
    setRecruitment((list) => [created, ...list]);
    audit('Candidate added', created.candidate, created.title);
    toast('success', `<strong>${created.candidate}</strong> added to pipeline`);
  };

  const deleteCandidate = async (id) => {
    const candidate = recruitment.find((c) => c.id === id);
    await recruitmentApi.remove(id);
    setRecruitment((list) => list.filter((c) => c.id !== id));
    audit('Candidate removed', candidate?.candidate || id, candidate?.title || '');
    toast('info', 'Candidate removed');
  };

  // ════════════════════════════════════════════════════════════
  //  HOLIDAYS — CRUD
  // ════════════════════════════════════════════════════════════
  const addHoliday = async (data) => {
    const created = await holidaysApi.create(data);
    setHolidays((list) => [...list, created]);
    audit('Holiday added', created.name, created.date);
    toast('success', `<strong>${created.name}</strong> added to calendar`);
    return created;
  };

  const deleteHoliday = async (id) => {
    const holiday = holidays.find((h) => h.id === id);
    await holidaysApi.remove(id);
    setHolidays((list) => list.filter((h) => h.id !== id));
    audit('Holiday removed', holiday?.name || id);
    toast('info', 'Holiday removed');
  };

  // ════════════════════════════════════════════════════════════
  //  PERFORMANCE — review cycles, self & manager appraisals, goals
  // ════════════════════════════════════════════════════════════
  const startReviewCycle = async (cycleName) => {
    const existing = new Set(reviews.filter((r) => r.cycleName === cycleName).map((r) => r.empId));
    const toCreate = employees.filter((e) => !existing.has(e.id));
    const created = await Promise.all(toCreate.map((e) => reviewsApi.create({
      cycleName,
      empId: e.id,
      name: e.name,
      dept: e.dept,
      status: 'pending',
      selfRating: null,
      selfComments: '',
      managerRating: null,
      managerComments: '',
      goals: [],
    })));
    setReviews((list) => [...created, ...list]);
    audit('Review cycle started', cycleName, `${created.length} employees`);
    toast('success', `Review cycle <strong>${cycleName}</strong> started for ${created.length} employees`);
    return created;
  };

  const submitSelfReview = async (id, { selfRating, selfComments }) => {
    const updated = await reviewsApi.update(id, { selfRating, selfComments, status: 'self-submitted' });
    setReviews((list) => list.map((r) => (r.id === id ? updated : r)));
    audit('Self review submitted', updated.name, updated.cycleName);
    toast('success', 'Self review submitted');
    return updated;
  };

  const submitManagerReview = async (id, { managerRating, managerComments }) => {
    const updated = await reviewsApi.update(id, { managerRating, managerComments, status: 'completed' });
    setReviews((list) => list.map((r) => (r.id === id ? updated : r)));
    if (updated.empId && managerRating != null) {
      await updateEmployee(updated.empId, { rating: Number(managerRating) });
    }
    audit('Manager review submitted', updated.name, updated.cycleName);
    toast('success', `Review completed for <strong>${updated.name}</strong>`);
    return updated;
  };

  const addGoal = async (id, text) => {
    const review = reviews.find((r) => r.id === id);
    const goals = [...(review?.goals || []), { id: uid('goal'), text, done: false }];
    const updated = await reviewsApi.update(id, { goals });
    setReviews((list) => list.map((r) => (r.id === id ? updated : r)));
  };

  const toggleGoal = async (id, goalId) => {
    const review = reviews.find((r) => r.id === id);
    if (!review) return;
    const goals = review.goals.map((g) => (g.id === goalId ? { ...g, done: !g.done } : g));
    const updated = await reviewsApi.update(id, { goals });
    setReviews((list) => list.map((r) => (r.id === id ? updated : r)));
  };

  // ════════════════════════════════════════════════════════════
  //  EXPENSES, ASSETS, AND JOBS ACTIONS
  // ════════════════════════════════════════════════════════════
  const addExpense = async (data) => {
    const created = await expensesApi.create({ status: 'pending', reason: '', ...data });
    setExpenses((list) => [created, ...list]);
    audit('Expense claim filed', created.name, `${created.category} - ₹${created.amount}`);
    toast('success', `Expense claim of <strong>₹${created.amount}</strong> submitted.`);
    return created;
  };

  const updateExpenseStatus = async (id, status, reason = '') => {
    const updated = await expensesApi.update(id, { status, reason });
    setExpenses((list) => list.map((e) => (e.id === id ? updated : e)));
    audit(`Expense claim ${status}`, updated.name, `₹${updated.amount}`);
    toast(status === 'approved' ? 'success' : 'info', `Expense claim for ${updated.name} has been <strong>${status}</strong>.`);
    return updated;
  };

  const addAsset = async (data) => {
    const created = await assetsApi.create({ status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '', ...data });
    setAssets((list) => [created, ...list]);
    audit('Asset added to inventory', created.name, created.serialNumber);
    toast('success', `Asset <strong>${created.name}</strong> added successfully.`);
    return created;
  };

  const assignAsset = async (id, empId, empName, date) => {
    const updated = await assetsApi.update(id, { status: 'assigned', assignedToEmpId: empId, assignedToEmpName: empName, assignedDate: date });
    setAssets((list) => list.map((a) => (a.id === id ? updated : a)));
    audit('Asset assigned', updated.name, `To ${empName}`);
    toast('success', `Asset <strong>${updated.name}</strong> assigned to ${empName}.`);
    return updated;
  };

  const returnAsset = async (id) => {
    const updated = await assetsApi.update(id, { status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '' });
    setAssets((list) => list.map((a) => (a.id === id ? updated : a)));
    audit('Asset returned', updated.name, 'Returned to inventory');
    toast('info', `Asset <strong>${updated.name}</strong> returned to inventory.`);
    return updated;
  };

  const addJob = async (data) => {
    const created = await jobsApi.create({ status: 'Open', ...data });
    setJobs((list) => [created, ...list]);
    audit('Job posting created', created.title, created.department);
    toast('success', `Job posting <strong>${created.title}</strong> created.`);
    return created;
  };

  const updateJobStatus = async (id, status) => {
    const updated = await jobsApi.update(id, { status });
    setJobs((list) => list.map((j) => (j.id === id ? updated : j)));
    audit('Job status updated', updated.title, status);
    toast('info', `Job <strong>${updated.title}</strong> marked as ${status}.`);
    return updated;
  };

  // ════════════════════════════════════════════════════════════
  //  SETTINGS
  // ════════════════════════════════════════════════════════════
  // Geofence/shift fields are server-authoritative (never trust a client
  // write for the values attendance verification depends on) — everything
  // else in "settings" stays local, same as before.
  const updateSettings = async (patch, notify = true) => {
    const localPatch = {};
    const serverPatch = {};
    for (const [key, value] of Object.entries(patch)) {
      (GEOFENCE_KEYS.includes(key) ? serverPatch : localPatch)[key] = value;
    }
    let merged = settings;
    if (Object.keys(localPatch).length) {
      merged = await settingsApi.update(localPatch);
    }
    if (Object.keys(serverPatch).length) {
      const geo = await geofenceApi.update(serverPatch);
      merged = { ...merged, ...geo };
    }
    setSettings(merged);
    if (notify) toast('success', 'Settings <strong>saved</strong>');
    return merged;
  };

  const toggleSetting = (key) => updateSettings({ [key]: !settings[key] }, false);

  const resetDatabase = async () => {
    setLoading(true);
    const all = await resetDB();
    localStorage.removeItem(AUDIT_KEY);
    setAuditLog([]);
    hydrate(all);
    setLoading(false);
    toast('info', 'Local demo data reset to defaults (employees/attendance on the server are unaffected)');
  };

  // ── Derived helpers exposed for convenience ─────────────────
  const pendingLeaves = leaves.filter((l) => l.status === 'pending');

  const value = {
    isAuthenticated: Boolean(authUser), login, loginWithFace, finishLogin, logout, forgotPassword, resetPassword,
    booting, loading, lastSyncedAt,
    employees, leaves, attendance, payroll,
    celebrations, holidays, recruitment, reviews, settings, currentUser, auditLog, audit,
    pendingLeaves,
    expenses, assets, jobs,
    addExpense, updateExpenseStatus,
    addAsset, assignAsset, returnAsset,
    addJob, updateJobStatus,
    // employees
    addEmployee, updateEmployee, deleteEmployee, importEmployees,
    // users (real login accounts, HR Director only)
    users, loadUsers, addUserAccount, updateUserAccount, deleteUserAccount,
    // leave
    addLeave, approveLeave, declineLeave, deleteLeave,
    // attendance
    checkIn, checkOut, setAttendanceStatus, recordPunch, enrollFace, faceEnrolled,
    // payroll
    processPayroll, markPaid, updatePayrollStructure,
    // celebrations
    sendWish,
    // holidays
    addHoliday, deleteHoliday,
    // recruitment
    moveCandidate, addCandidate, deleteCandidate, toggleOnboardingItem,
    // performance reviews
    startReviewCycle, submitSelfReview, submitManagerReview, addGoal, toggleGoal,
    // settings
    updateSettings, toggleSetting, resetDatabase,
    // helpers used by forms
    leaveDays: daysBetween, today: todayISO,
    // ui
    toast, toasts, dismissToast,
    search, setSearch,
  };

  return <HRMSContext.Provider value={value}>{children}</HRMSContext.Provider>;
}
