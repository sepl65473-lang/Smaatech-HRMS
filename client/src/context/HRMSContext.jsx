import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { toast as reactToast } from 'react-toastify';
import {
  loadAll, resetDB, reloadFromDisk, DB_STORAGE_KEY,

  employeesApi, leavesApi, attendanceApi, payrollApi,
  celebrationsApi, recruitmentApi, settingsApi, holidaysApi, reviewsApi,
  expensesApi, assetsApi, jobsApi, authApi, geofenceApi, faceApi, usersApi, rolesApi, masterCategoriesApi, masterValuesApi, auditLogsApi, notificationsApi, documentsApi, resignationsApi, attendanceCorrectionsApi,
} from '../data/store';
import { setAccessToken } from '../lib/apiClient';
import { getDeviceId } from '../lib/deviceId';
import { uid, daysBetween, todayISO, DEPARTMENTS as fallbackDepts, LOCATIONS as fallbackLocs, LEAVE_TYPES as fallbackLeaves } from '../lib/helpers';
import { resolveShiftForToday, isLate as isLateForShift } from '../lib/shifts';
import {
  canAccess as fallbackCanAccess,
  canDo as fallbackCanDo,
} from '../lib/permissions';


const HRMSContext = createContext(null);

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
  const [roles, setRoles] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [resignations, setResignations] = useState([]);
  const [attendanceCorrections, setAttendanceCorrections] = useState([]);
  const [masterCategories, setMasterCategories] = useState([]);
  const [masterValues, setMasterValues] = useState([]);
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
  const [auditLog, setAuditLog] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => Date.now());

  const [toasts, setToasts] = useState([]);

  const [search, setSearch] = useState('');

  // ── Toasts ─────────────────────────────────────────────────
  const dismissToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((type, msg) => {
    const plain = String(msg).replace(/<\/?strong>/g, '');
    if (type === 'success') reactToast.success(plain);
    else if (type === 'error') reactToast.error(plain);
    else if (type === 'info') reactToast.info(plain);
    else reactToast(plain);
  }, []);


  // Local-only echo for actions the server already logs via logAudit() on the
  // mutating request itself — gives instant Activity history feedback without
  // writing a second, duplicate AuditLog document for the same real event.
  const auditLocal = useCallback((action, subject, details = '') => {
    setAuditLog((list) => [{
      id: uid('audit'),
      action,
      subject,
      details,
      actor: currentUser?.name || 'System',
      role: currentUser?.role || '',
      at: new Date().toISOString(),
    }, ...list].slice(0, 100));
  }, [currentUser]);

  const audit = useCallback(async (action, subject, details = '') => {
    try {
      const created = await auditLogsApi.create({ action, subject, details });
      setAuditLog((list) => [created, ...list].slice(0, 100));
      return created;
    } catch (err) {
      console.warn('[Audit Log Client Warning] Failed to log action to backend:', err);
      const entry = {
        id: uid('audit'),
        action,
        subject,
        details,
        actor: currentUser?.name || 'System',
        role: currentUser?.role || '',
        at: new Date().toISOString(),
      };
      setAuditLog((list) => [entry, ...list].slice(0, 100));
      return entry;
    }
  }, [currentUser]);

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
    setRoles(all.roles || []);
    setMasterCategories(all.masterCategories || []);
    setMasterValues(all.masterValues || []);
    setAuditLog(all.auditLogs || []);
    setNotifications(all.notifications || []);
    setDocuments(all.documents || []);
    setResignations(all.resignations || []);
    setAttendanceCorrections(all.attendanceCorrections || []);
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
    setRoles([]);
    setMasterCategories([]);
    setMasterValues([]);
    setAuditLog([]);
    setNotifications([]);
    setFaceEnrolled(false);
    toast('info', 'Signed out');
  }, [toast]);

  const forgotPassword = useCallback((email) => authApi.forgotPassword(email), []);
  const resetPassword = useCallback((email, otp, newPassword) => authApi.resetPassword(email, otp, newPassword), []);

  const loadSessions = useCallback(() => authApi.sessions(), []);
  const revokeSession = useCallback(async (id) => {
    await authApi.revokeSession(id);
    toast('info', 'Session signed out.');
  }, [toast]);
  const revokeOtherSessions = useCallback(async () => {
    const { revoked } = await authApi.revokeOtherSessions();
    toast('success', `Signed out of ${revoked} other session${revoked === 1 ? '' : 's'}.`);
    return revoked;
  }, [toast]);

  const markNotificationRead = useCallback(async (id) => {
    try {
      const updated = await notificationsApi.markRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? updated : n)));
    } catch (err) {
      toast('error', 'Failed to mark notification as read');
    }
  }, [toast]);

  const markAllNotificationsRead = useCallback(async () => {
    try {
      await notificationsApi.readAll();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      toast('success', 'All notifications marked as read');
    } catch (err) {
      toast('error', 'Failed to mark all as read');
    }
  }, [toast]);

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
    auditLocal('Employee added', created.name, created.dept);
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
    auditLocal('Employee updated', updated.name, updated.dept);
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

    auditLocal('Employee removed', emp ? emp.name : id, 'Linked records removed');
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

  const importAssets = async (rows) => {
    let count = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await addAsset(row);
      count += 1;
    }
    audit('Assets imported', `${count} rows`, 'CSV import');
    toast('success', `Imported <strong>${count}</strong> asset${count === 1 ? '' : 's'}`);
    return count;
  };

  const importHolidays = async (rows) => {
    let count = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await addHoliday(row);
      count += 1;
    }
    audit('Holidays imported', `${count} rows`, 'CSV import');
    toast('success', `Imported <strong>${count}</strong> holiday${count === 1 ? '' : 's'}`);
    return count;
  };

  const importJobs = async (rows) => {
    let count = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await addJob(row);
      count += 1;
    }
    audit('Jobs imported', `${count} rows`, 'CSV import');
    toast('success', `Imported <strong>${count}</strong> job opening${count === 1 ? '' : 's'}`);
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
    auditLocal('Login created', created.name, created.email);
    toast('success', `Login created for <strong>${created.name}</strong>`);
    return created;
  };

  const updateUserAccount = async (id, patch) => {
    const updated = await usersApi.update(id, patch);
    setUsers((list) => list.map((u) => (u.id === id ? updated : u)));
    auditLocal('Login updated', updated.name, updated.email);
    toast('success', `<strong>${updated.name}</strong>'s login updated`);
    return updated;
  };

  const deleteUserAccount = async (id) => {
    const user = users.find((u) => u.id === id);
    await usersApi.remove(id);
    setUsers((list) => list.filter((u) => u.id !== id));
    auditLocal('Login removed', user ? user.name : id);
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
    auditLocal('Leave requested', created.name, `${created.type} leave`);
    toast('success', `Leave request raised for <strong>${created.name}</strong>`);
    return created;
  };

  // Goes through the server's stage-aware approve/decline endpoints (see
  // routes/leave.js) rather than a plain status PATCH — the server checks
  // the caller's role against the request's current approval stage, and
  // `updated.status` only actually becomes 'approved' once every configured
  // stage (Settings > Workflows) has signed off.
  const setLeaveStatus = async (id, action) => {
    const updated = action === 'approved' ? await leavesApi.approve(id) : await leavesApi.decline(id);
    setLeaves((list) => list.map((l) => (l.id === id ? updated : l)));
    if (updated.status === 'approved' && updated.empId) {
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
    if (action === 'declined') {
      toast('info', `Leave <strong>declined</strong> for ${updated.name}`);
    } else if (updated.status === 'approved') {
      toast('success', `Leave <strong>approved</strong> for ${updated.name}`);
    } else {
      const nextRole = updated.approvalStages?.[updated.currentStage];
      toast('info', `Stage approved for ${updated.name}${nextRole ? ` — awaiting <strong>${nextRole}</strong>` : ''}`);
    }
    auditLocal(`Leave ${action === 'declined' ? 'declined' : (updated.status === 'approved' ? 'approved' : 'stage approved')}`, updated.name, `${updated.start} to ${updated.end}`);
    return updated;
  };
  const approveLeave = (id) => setLeaveStatus(id, 'approved');
  const declineLeave = (id) => setLeaveStatus(id, 'declined');

  const deleteLeave = async (id) => {
    await leavesApi.remove(id);
    setLeaves((list) => list.filter((l) => l.id !== id));
    auditLocal('Leave deleted', id);
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
    auditLocal('Salary structure updated', updated.name, updated.cycle);
    toast('success', `Salary structure updated for <strong>${updated.name}</strong>`);
    return updated;
  };

  const markPaid = async (id) => {
    const updated = await payrollApi.update(id, { status: 'paid' });
    setPayroll((list) => list.map((p) => (p.id === id ? updated : p)));
    auditLocal('Payslip marked paid', updated.name, updated.cycle);
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
    auditLocal('Expense claim filed', created.name, `${created.category} - ₹${created.amount}`);
    toast('success', `Expense claim of <strong>₹${created.amount}</strong> submitted.`);
    return created;
  };

  // Same stage-aware approve/decline pattern as leave (see setLeaveStatus) —
  // goes through routes/expenses.js's dedicated endpoints instead of a plain
  // status PATCH, so the server can enforce Settings > Workflows.
  const updateExpenseStatus = async (id, status, reason = '') => {
    const updated = status === 'approved' ? await expensesApi.approve(id) : await expensesApi.decline(id, reason);
    setExpenses((list) => list.map((e) => (e.id === id ? updated : e)));
    if (status === 'declined') {
      auditLocal('Expense claim declined', updated.name, `₹${updated.amount}`);
      toast('info', `Expense claim for ${updated.name} has been <strong>declined</strong>.`);
    } else if (updated.status === 'approved') {
      auditLocal('Expense claim approved', updated.name, `₹${updated.amount}`);
      toast('success', `Expense claim for ${updated.name} has been <strong>approved</strong>.`);
    } else {
      const nextRole = updated.approvalStages?.[updated.currentStage];
      auditLocal('Expense claim stage approved', updated.name, `₹${updated.amount}`);
      toast('info', `Stage approved for ${updated.name}'s claim${nextRole ? ` — awaiting <strong>${nextRole}</strong>` : ''}`);
    }
    return updated;
  };

  const addAsset = async (data) => {
    const created = await assetsApi.create({ status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '', ...data });
    setAssets((list) => [created, ...list]);
    auditLocal('Asset added to inventory', created.name, created.serialNumber);
    toast('success', `Asset <strong>${created.name}</strong> added successfully.`);
    return created;
  };

  const assignAsset = async (id, empId, empName, date) => {
    const updated = await assetsApi.update(id, { status: 'assigned', assignedToEmpId: empId, assignedToEmpName: empName, assignedDate: date });
    setAssets((list) => list.map((a) => (a.id === id ? updated : a)));
    auditLocal('Asset assigned', updated.name, `To ${empName}`);
    toast('success', `Asset <strong>${updated.name}</strong> assigned to ${empName}.`);
    return updated;
  };

  const returnAsset = async (id) => {
    const updated = await assetsApi.update(id, { status: 'available', assignedToEmpId: null, assignedToEmpName: '', assignedDate: '' });
    setAssets((list) => list.map((a) => (a.id === id ? updated : a)));
    auditLocal('Asset returned', updated.name, 'Returned to inventory');
    toast('info', `Asset <strong>${updated.name}</strong> returned to inventory.`);
    return updated;
  };

  const addJob = async (data) => {
    const created = await jobsApi.create({ status: 'Open', ...data });
    setJobs((list) => [created, ...list]);
    auditLocal('Job posting created', created.title, created.department);
    toast('success', `Job posting <strong>${created.title}</strong> created.`);
    return created;
  };

  const updateJobStatus = async (id, status) => {
    const updated = await jobsApi.update(id, { status });
    setJobs((list) => list.map((j) => (j.id === id ? updated : j)));
    auditLocal('Job status updated', updated.title, status);
    toast('info', `Job <strong>${updated.title}</strong> marked as ${status}.`);
    return updated;
  };

  // ── Documents ──────────────────────────────────────────────
  const addDocument = async (formData) => {
    const created = await documentsApi.create(formData);
    setDocuments((list) => [created, ...list]);
    auditLocal('Document uploaded', created.title, created.owner);
    toast('success', `Document <strong>${created.title}</strong> uploaded successfully.`);
    return created;
  };

  const updateDocument = async (id, formData) => {
    const updated = await documentsApi.update(id, formData);
    setDocuments((list) => list.map((d) => (d.id === id ? updated : d)));
    auditLocal('Document updated', updated.title, updated.owner);
    toast('success', `Document <strong>${updated.title}</strong> updated.`);
    return updated;
  };

  const deleteDocument = async (id) => {
    await documentsApi.remove(id);
    setDocuments((list) => list.filter((d) => d.id !== id));
    auditLocal('Document deleted', id);
    toast('info', 'Document deleted.');
  };

  const downloadDocument = async (id) => {
    return documentsApi.download(id);
  };

  // ── Resignations & clearances ──────────────────────────────
  const addResignation = async (data) => {
    const created = await resignationsApi.create(data);
    setResignations((list) => [created, ...list]);
    auditLocal('Resignation filed', created.employeeName, created.resignationDate);
    toast('success', `Resignation filed successfully.`);
    return created;
  };

  const signOffClearance = async (id, clearance) => {
    const updated = await resignationsApi.signOffClearance(id, clearance);
    setResignations((list) => list.map((r) => (r.id === id ? updated : r)));
    auditLocal(`Clearance sign-off (${clearance.dept})`, updated.employeeName, clearance.status);
    toast('success', `${clearance.dept} clearance status updated to ${clearance.status}.`);
    return updated;
  };

  const processFnF = async (id, fnf) => {
    const updated = await resignationsApi.processFnF(id, fnf);
    setResignations((list) => list.map((r) => (r.id === id ? updated : r)));
    auditLocal('FnF Settlement processed', updated.employeeName, `Payout: ₹${updated.fnfSettlement.netPayout}`);
    toast('success', `FnF Settlement calculations processed.`);
    return updated;
  };

  const payFnF = async (id) => {
    const updated = await resignationsApi.payFnF(id);
    setResignations((list) => list.map((r) => (r.id === id ? updated : r)));
    
    const empList = await employeesApi.list();
    setEmployees(empList);

    auditLocal('FnF Paid & Employee Terminated', updated.employeeName, 'Payout finalized');
    toast('success', `Full & Final payout processed. Employee marked Exited.`);
    return updated;
  };

  const updateResignationStatus = async (id, patch) => {
    const updated = await resignationsApi.update(id, patch);
    setResignations((list) => list.map((r) => (r.id === id ? updated : r)));
    auditLocal('Resignation status updated', updated.employeeName, updated.status);
    toast('info', `Resignation status updated to ${updated.status}.`);
    return updated;
  };

  // ── Attendance Corrections ─────────────────────────────────
  const requestCorrection = async (data) => {
    const created = await attendanceCorrectionsApi.create(data);
    setAttendanceCorrections((list) => [created, ...list]);
    auditLocal('Attendance correction requested', created.employeeName, created.date);
    toast('success', `Attendance correction requested successfully.`);
    return created;
  };

  const approveCorrection = async (id) => {
    const updated = await attendanceCorrectionsApi.approve(id);
    setAttendanceCorrections((list) => list.map((c) => (c.id === id ? updated : c)));
    
    const attList = await attendanceApi.list();
    setAttendance(attList);

    auditLocal('Attendance correction approved', updated.employeeName, updated.date);
    toast('success', `Correction approved. Attendance marked present.`);
    return updated;
  };

  const rejectCorrection = async (id) => {
    const updated = await attendanceCorrectionsApi.reject(id);
    setAttendanceCorrections((list) => list.map((c) => (c.id === id ? updated : c)));
    auditLocal('Attendance correction rejected', updated.employeeName, updated.date);
    toast('info', `Correction request rejected.`);
    return updated;
  };

  // ════════════════════════════════════════════════════════════
  //  SETTINGS
  // ════════════════════════════════════════════════════════════
  // Geofence/shift/workflow fields are server-authoritative (never trust a
  // client write for values attendance verification or approval routing
  // depend on) — everything else in "settings" stays local, same as before.
  const updateSettings = async (patch, notify = true) => {
    const merged = await settingsApi.update(patch);
    setSettings(merged);
    if (notify) toast('success', 'Settings <strong>saved</strong>');
    return merged;
  };

  const toggleSetting = (key) => updateSettings({ [key]: !settings[key] }, false);

  const resetDatabase = async () => {
    setLoading(true);
    const all = await resetDB();
    setAuditLog([]);
    hydrate(all);
    setLoading(false);
    toast('info', 'Database settings reset to defaults.');
  };

  const contextCanAccess = useCallback((path) => {
    const role = currentUser.role;
    if (!role) return false;
    if (role === 'HR Director') return true;
    const roleDef = roles.find((r) => r.name === role);
    if (roleDef) {
      if (roleDef.allowedPaths.includes('*')) return true;
      return roleDef.allowedPaths.includes(path);
    }
    return fallbackCanAccess(role, path);
  }, [currentUser.role, roles]);

  const contextCanDo = useCallback((action) => {
    const role = currentUser.role;
    if (!role) return false;
    if (role === 'HR Director') return true;
    const roleDef = roles.find((r) => r.name === role);
    if (roleDef) {
      return roleDef.allowedActions.includes(action);
    }
    return fallbackCanDo(role, action);
  }, [currentUser.role, roles]);

  const addRole = async (data) => {
    const created = await rolesApi.create(data);
    setRoles((list) => [...list, created]);
    audit('Role created', created.name, created.description);
    toast('success', `Role <strong>${created.name}</strong> created.`);
    return created;
  };

  const updateRole = async (id, patch) => {
    const updated = await rolesApi.update(id, patch);
    setRoles((list) => list.map((r) => (r.id === id ? updated : r)));
    audit('Role updated', updated.name, updated.description);
    toast('success', `Role <strong>${updated.name}</strong> updated.`);
    return updated;
  };

  const deleteRole = async (id) => {
    const roleDef = roles.find((r) => r.id === id);
    await rolesApi.remove(id);
    setRoles((list) => list.filter((r) => r.id !== id));
    audit('Role deleted', roleDef ? roleDef.name : id);
    toast('info', `Role deleted.`);
  };

  const addMasterValue = async (categoryId, value) => {
    const created = await masterValuesApi.create({ categoryId, value });
    setMasterValues((list) => [...list, created]);
    audit('Master value added', created.value);
    toast('success', `<strong>${created.value}</strong> added.`);
    return created;
  };

  const updateMasterValue = async (id, patch) => {
    const updated = await masterValuesApi.update(id, patch);
    setMasterValues((list) => list.map((v) => (v.id === id ? updated : v)));
    return updated;
  };

  const deleteMasterValue = async (id) => {
    const row = masterValues.find((v) => v.id === id);
    await masterValuesApi.remove(id);
    setMasterValues((list) => list.filter((v) => v.id !== id));
    audit('Master value removed', row ? row.value : id);
    toast('info', 'Removed.');
  };

  const getMasterValues = useCallback((code) => {
    const category = masterCategories.find((c) => c.code === code);
    if (!category) {
      if (code === 'locations') return fallbackLocs;
      if (code === 'departments') return fallbackDepts;
      if (code === 'leave_types') return fallbackLeaves.map((l) => l.value);
      if (code === 'document_types') return ['PDF', 'DOC', 'IMG', 'XLS'];
      return [];
    }
    const vals = masterValues
      .filter((v) => v.categoryId === category.id && v.active !== false)
      .map((v) => v.value);
    if (vals.length === 0) {
      if (code === 'locations') return fallbackLocs;
      if (code === 'departments') return fallbackDepts;
      if (code === 'leave_types') return fallbackLeaves.map((l) => l.value);
      if (code === 'document_types') return ['PDF', 'DOC', 'IMG', 'XLS'];
    }
    return vals;
  }, [masterCategories, masterValues]);

  // ── Derived helpers exposed for convenience ─────────────────
  const pendingLeaves = leaves.filter((l) => l.status === 'pending');

  const value = {
    isAuthenticated: Boolean(authUser), login, loginWithFace, finishLogin, logout, forgotPassword, resetPassword,
    loadSessions, revokeSession, revokeOtherSessions,
    booting, loading, lastSyncedAt,
    employees, leaves, attendance, payroll,
    celebrations, holidays, recruitment, reviews, settings, currentUser, auditLog, audit,
    pendingLeaves,
    expenses, assets, jobs, roles, masterCategories, masterValues, documents, resignations, attendanceCorrections,
    addDocument, updateDocument, deleteDocument, downloadDocument,
    addResignation, signOffClearance, processFnF, payFnF, updateResignationStatus,
    requestCorrection, approveCorrection, rejectCorrection,
    getMasterValues, addMasterValue, updateMasterValue, deleteMasterValue,
    canAccess: contextCanAccess,
    canDo: contextCanDo,
    addRole, updateRole, deleteRole,
    addExpense, updateExpenseStatus,
    addAsset, assignAsset, returnAsset, importAssets,
    addJob, updateJobStatus, importJobs,
    // employees
    addEmployee, updateEmployee, deleteEmployee, importEmployees,
    importHolidays,
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
    notifications, markNotificationRead, markAllNotificationsRead,
  };

  return <HRMSContext.Provider value={value}>{children}</HRMSContext.Provider>;
}
