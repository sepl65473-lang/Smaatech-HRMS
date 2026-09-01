import { apiFetch, apiFetchBlob, setAccessToken } from '../lib/apiClient';

// ─────────────────────────────────────────────────────────────
//  DATA LAYER
//
//  Employees, Attendance, Users, Leave, Payroll, Celebrations, Holidays,
//  Recruitment, Reviews, Expenses, Assets, Jobs, and the geofence/shift
//  subset of Settings all live on the real backend (server/) now — see
//  the "Real backend resources" section below, which calls the REST API
//  directly via restResource()/apiFetch.
//
//  Only the rest of Settings (org config, notification templates, gateway
//  credential placeholders, departments/designations) still persists to
//  localStorage — see `settingsApi` below, still swappable to a real API
//  the same way this file has always documented: replace its method bodies
//  with fetch() calls. Nothing else in the app has to change.
// ─────────────────────────────────────────────────────────────

export const DB_STORAGE_KEY = 'Smaatech_hrms_db_v1';

// Current implementation: company settings are persisted through the API.
// Local-only settings (org config, login profiles/face descriptors,
// notification templates, gateway credentials, etc). The geofence/shift
// subset that attendance verification depends on lives server-side instead —
// see geofenceApi.
export const settingsApi = {
  get() {
    return apiFetch('/settings');
  },
  update(patch) {
    return apiFetch('/settings', { method: 'PATCH', body: patch });
  },
  // Server-generated only — the plain key is only ever returned by this one
  // call, right after generation, never re-shown by settingsApi.get().
  regenerateDeviceKey() {
    return apiFetch('/settings/device-key/regenerate', { method: 'POST' });
  },
};

// ── Real backend resources ──────────────────────────────────────────────

function restResource(path, methods = ['list', 'get', 'create', 'update', 'remove']) {
  const all = {
    list: () => apiFetch(`/${path}`),
    get: (id) => apiFetch(`/${path}/${id}`),
    create: (data) => apiFetch(`/${path}`, { method: 'POST', body: data }),
    update: (id, patch) => apiFetch(`/${path}/${id}`, { method: 'PATCH', body: patch }),
    remove: (id) => apiFetch(`/${path}/${id}`, { method: 'DELETE' }),
  };
  return Object.fromEntries(methods.map((m) => [m, all[m]]));
}

export const employeesApi = {
  ...restResource('employees'),
  // Server-side paginated/filtered directory search — opt-in (any legacy
  // .list() caller with no params still gets the full unpaginated roster).
  search: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    return apiFetch(`/employees${qs ? `?${qs}` : ''}`);
  },
};

// Real login accounts (Settings > Users & role access). HR Director only —
// deliberately not part of loadAll()/hydrate, since GET /users would 403 for
// every other role; fetched lazily from the Settings page instead. No single-
// user GET route exists server-side, so `get` is intentionally omitted here.
export const usersApi = {
  ...restResource('users', ['list', 'create', 'update', 'remove']),
  // Admin counterpart to authApi.sessions() below — HR Director viewing/
  // revoking someone ELSE's active sessions (server/src/routes/users.js).
  sessions: (userId) => apiFetch(`/users/${userId}/sessions`),
  revokeSession: (userId, sessionId) => apiFetch(`/users/${userId}/sessions/${sessionId}`, { method: 'DELETE' }),
};

export const leavesApi = {
  ...restResource('leaves'),
  // Stage-aware approve/decline (see server/src/routes/leave.js) — the
  // server checks the caller's role against the request's current stage.
  approve: (id) => apiFetch(`/leaves/${id}/approve`, { method: 'POST' }),
  decline: (id) => apiFetch(`/leaves/${id}/decline`, { method: 'POST' }),
};
export const payrollApi = restResource('payroll');
export const holidaysApi = restResource('holidays');
export const recruitmentApi = restResource('recruitment');
export const reviewsApi = restResource('reviews');
export const expensesApi = {
  ...restResource('expenses'),
  approve: (id) => apiFetch(`/expenses/${id}/approve`, { method: 'POST' }),
  decline: (id, reason) => apiFetch(`/expenses/${id}/decline`, { method: 'POST', body: { reason } }),
};
export const assetsApi = restResource('assets');
export const jobsApi = restResource('jobs');
export const rolesApi = restResource('roles');
export const masterCategoriesApi = restResource('master-data/master-categories');
export const masterValuesApi = restResource('master-data/master-values');
export const auditLogsApi = {
  ...restResource('audit-logs'),
  // Server-side paginated/filtered history — opt-in, mirrors employeesApi.search.
  search: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    return apiFetch(`/audit-logs${qs ? `?${qs}` : ''}`);
  },
};
export const notificationsApi = {
  ...restResource('notifications'),
  readAll: () => apiFetch('/notifications/read-all', { method: 'PATCH' }),
  markRead: (id) => apiFetch(`/notifications/${id}/read`, { method: 'PATCH' }),
};

export const documentsApi = {
  list: () => apiFetch('/documents'),
  create: (formData) => apiFetch('/documents', { method: 'POST', body: formData }),
  update: (id, formData) => apiFetch(`/documents/${id}`, { method: 'PATCH', body: formData }),
  remove: (id) => apiFetch(`/documents/${id}`, { method: 'DELETE' }),
  download: (id) => apiFetchBlob(`/documents/${id}/download`),
};

export const resignationsApi = {
  list: () => apiFetch('/resignations'),
  create: (data) => apiFetch('/resignations', { method: 'POST', body: data }),
  update: (id, patch) => apiFetch(`/resignations/${id}`, { method: 'PATCH', body: patch }),
  signOffClearance: (id, clearance) => apiFetch(`/resignations/${id}/clearance`, { method: 'POST', body: clearance }),
  processFnF: (id, fnf) => apiFetch(`/resignations/${id}/fnf`, { method: 'POST', body: fnf }),
  payFnF: (id) => apiFetch(`/resignations/${id}/fnf/pay`, { method: 'POST' }),
};

export const attendanceCorrectionsApi = {
  list: () => apiFetch('/attendance-corrections'),
  create: (data) => apiFetch('/attendance-corrections', { method: 'POST', body: data }),
  approve: (id) => apiFetch(`/attendance-corrections/${id}/approve`, { method: 'POST' }),
  reject: (id) => apiFetch(`/attendance-corrections/${id}/reject`, { method: 'POST' }),
};

// Celebrations is computed server-side from real Employee dob/joinDate
// (see server/src/routes/celebrations.js) rather than a stored collection —
// only GET (list) and PATCH (send wish) exist as real routes, so those are
// the only methods requested here.
export const celebrationsApi = restResource('celebrations', ['list', 'update']);

export const attendanceApi = {
  ...restResource('attendance'),
  // The verified self check-in/out path — the server independently re-derives
  // geofence distance and lateness rather than trusting anything in `payload`.
  checkIn: (id, payload) => apiFetch(`/attendance/${id}/check-in`, { method: 'POST', body: payload }),
  checkOut: (id, payload) => apiFetch(`/attendance/${id}/check-out`, { method: 'POST', body: payload }),
  // Real per-department present/late/absent totals over a date range (server
  // aggregates from actual daily history) — feeds Dashboard's AttendanceChart.
  summary: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    ).toString();
    return apiFetch(`/attendance/summary${qs ? `?${qs}` : ''}`);
  },
  // Real QR check-in — a server-issued/validated token, not a client-only
  // decorative one. qrToken() is HR-only (the office display); qrCheckIn()
  // is called by the scanning employee's own authenticated session.
  qrToken: () => apiFetch('/attendance/qr-token'),
  qrCheckIn: (payload) => apiFetch('/attendance/qr-checkin', { method: 'POST', body: payload }),
};

// Persisted biometric-device-user -> employee links (Integrations.jsx).
export const deviceMappingsApi = restResource('device-mappings', ['list', 'create', 'remove']);

// Server-side face enrollment — uploads the captured photo; the server
// computes and stores the descriptor itself (never a client-computed value).
export const faceApi = {
  // `target` may be a server User id, an email (for admin-assisted
  // enrollment from Settings > Users, whose local records only carry an
  // email), or omitted to enroll the caller's own account.
  enroll: (photoBlob, target) => {
    const form = new FormData();
    form.append('photo', photoBlob, 'enroll.jpg');
    if (target?.includes('@')) form.append('email', target);
    else if (target) form.append('userId', target);
    return apiFetch('/face/enroll', { method: 'POST', body: form });
  },
  status: (userId) => apiFetch(`/face/status/${userId}`),
};

// Server-authoritative geofence + shift config (the subset of "settings"
// attendance verification depends on — see server/src/models/Settings.js).
export const geofenceApi = {
  get: () => apiFetch('/settings'),
  update: (patch) => apiFetch('/settings', { method: 'PATCH', body: patch }),
};

export const authApi = {
  // Returns either { accessToken, user } (session issued immediately) or
  // { requiresTwoFactor: true, email } (server emailed a real OTP and is
  // waiting on verifyTwoFactor before any session exists) — the server
  // decides which, based on that company's Settings > Two-factor toggle.
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true }),
  // Sends the captured photo alongside the matched email so the server can
  // re-verify the face itself (see server/src/routes/auth.js) — the client's
  // own match (src/lib/faceAuth.js) only decides which account to attempt.
  faceLogin: (email, photoBlob) => {
    const form = new FormData();
    form.append('email', email);
    form.append('photo', photoBlob, 'face-login.jpg');
    return apiFetch('/auth/face-login', { method: 'POST', body: form, skipAuth: true });
  },
  verifyTwoFactor: (email, otp) => apiFetch('/auth/verify-2fa', { method: 'POST', body: { email, otp }, skipAuth: true }),
  async me() {
    try {
      const { user } = await apiFetch('/auth/me');
      return user;
    } catch {
      return null;
    }
  },
  // Called on app load: no access token in memory yet (a page refresh wipes
  // JS memory), but a valid httpOnly refresh cookie may still be present.
  async bootstrap() {
    try {
      const data = await apiFetch('/auth/refresh', { method: 'POST', skipAuth: true });
      setAccessToken(data.accessToken);
      return data.user;
    } catch {
      setAccessToken(null);
      return null;
    }
  },
  async logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    setAccessToken(null);
  },
  // Two-step, real-email flow: request a code, then submit it with the new
  // password. Replaces the old single-step "just type an email" reset.
  forgotPassword: (email) =>
    apiFetch('/auth/forgot-password', { method: 'POST', body: { email }, skipAuth: true }),
  resetPassword: (email, otp, newPassword) =>
    apiFetch('/auth/reset-password', { method: 'POST', body: { email, otp, newPassword }, skipAuth: true }),
  changePassword: (currentPassword, newPassword) =>
    apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  sessions: () => apiFetch('/auth/sessions'),
  revokeSession: (id) => apiFetch(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeOtherSessions: () => apiFetch('/auth/sessions/revoke-others', { method: 'POST' }),
};

// Load everything at once for the app shell. Requires an authenticated
// session (employees/attendance/geofence and all 9 modules below are behind
// requireAuth) — only call this after authApi has established a session.
export async function loadAll() {
  const [
    employees, attendance, leaves, payroll, celebrations, holidays,
    recruitment, reviews, expenses, assets, jobs,
    settings, roles, masterCategories, masterValues,
    auditLogs, notifications, documents, resignations, attendanceCorrections,
  ] = await Promise.all([
    employeesApi.list(),
    attendanceApi.list(),
    leavesApi.list(),
    payrollApi.list(),
    celebrationsApi.list(),
    holidaysApi.list(),
    recruitmentApi.list(),
    reviewsApi.list(),
    expensesApi.list(),
    assetsApi.list(),
    jobsApi.list(),
    settingsApi.get(),
    rolesApi.list(),
    masterCategoriesApi.list(),
    masterValuesApi.list(),
    auditLogsApi.list().catch(() => []),
    notificationsApi.list().catch(() => []),
    documentsApi.list().catch(() => []),
    resignationsApi.list().catch(() => []),
    attendanceCorrectionsApi.list().catch(() => []),
  ]);
  return {
    employees, attendance, leaves, payroll, celebrations, holidays,
    recruitment, reviews, expenses, assets, jobs, roles, masterCategories, masterValues,
    auditLogs, notifications, documents, resignations, attendanceCorrections,
    settings,
  };
}

// Re-reads and refetches all backend collections.
export async function reloadFromDisk() {
  return loadAll();
}

// Reset company settings back to default values.
export async function resetDB() {
  const defaultSettings = {
    orgName: 'Smaatech',
    workWeek: '5-day',
    notifyLeave: true,
    notifyPayroll: true,
    notifyBirthday: false,
    twoFactor: true,
    wishesSent: 0,
    totalLeaveDays: 24,
    departments: ['Engineering', 'Design', 'Sales', 'Marketing', 'HR'],
    designations: ['Software Engineer', 'Senior Software Engineer', 'Product Manager', 'HR Manager'],
    gatewayTwilioSid: '',
    gatewayTwilioToken: '',
    gatewayTwilioFrom: '',
    gatewaySendgridKey: '',
    gatewaySmtpHost: '',
    gatewaySmtpUser: '',
    gatewaySmtpPass: '',
    gpsCheckInEnabled: false,
    geofenceLat: 19.0760,
    geofenceLng: 72.8777,
    geofenceRadius: 25,
    notificationTemplates: {
      email: {
        leaveApproval: 'Subject: Leave Approval Notification\n\nDear {employee},\n\nWe are pleased to inform you that your leave request for the period {date} has been approved.\n\nBest regards,\nPeople Operations Team',
        payrollSlip: 'Subject: Monthly Salary Slip Published\n\nDear {employee},\n\nYour salary slip for {date} is now available in your ESS dashboard portal.\n\nBest regards,\nFinance Team'
      },
      sms: {
        leaveApproval: 'Dear {employee}, your leave request for {date} has been approved by Operations. Smaatech',
        payrollSlip: 'Dear {employee}, your payslip for {date} has been processed. Log in to ESS portal to view details. Smaatech'
      },
      whatsapp: {
        leaveApproval: 'Hello *{employee}*,\n\nYour leave request for *{date}* has been *approved* by your supervisor. ✅\n\nRegards,\nHR Operations',
        payrollSlip: 'Hello *{employee}*,\n\nYour salary slip for *{date}* is ready. You can view or download it under your ESS dashboard. 📊'
      }
    },
    notifyChannels: {
      leave: ['In-app'],
      payroll: ['In-app'],
      birthday: ['In-app']
    },
    approvalWorkflows: {
      leave: ['HR Manager', 'HR Director'],
      expense: ['Finance Lead', 'HR Director']
    }
  };
  await settingsApi.update(defaultSettings);
  return loadAll();
}
