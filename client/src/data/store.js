import { apiFetch, apiFetchBlob, setAccessToken } from '../lib/apiClient';
import { canAccess } from '../lib/permissions';

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
  resendWelcome: (userId) => apiFetch(`/users/${userId}/resend-welcome`, { method: 'POST' }),
};

export const leavesApi = {
  ...restResource('leaves'),
  // Stage-aware approve/decline (see server/src/routes/leave.js) — the
  // server checks the caller's role against the request's current stage.
  approve: (id) => apiFetch(`/leaves/${id}/approve`, { method: 'POST' }),
  decline: (id, note) => apiFetch(`/leaves/${id}/decline`, { method: 'POST', body: { note: note || '' } }),
  withdraw: (id) => apiFetch(`/leaves/${id}/withdraw`, { method: 'POST' }),
  // Server-computed, ledger-backed balance. The Leave page used to derive
  // "days left" in the browser from the leave rows it happened to hold, against
  // hardcoded 12/24-day quotas — a number the server never agreed with and
  // never enforced. These are the figures the server actually reserves against.
  balance: (empId, year) => {
    const qs = new URLSearchParams(
      Object.entries({ empId, year }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/leaves/balance${qs ? `?${qs}` : ''}`);
  },
  ledger: (empId, year) => {
    const qs = new URLSearchParams(
      Object.entries({ empId, year }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/leaves/ledger${qs ? `?${qs}` : ''}`);
  },
  // The company's configured leave policy. HR passes includeInactive to see
  // retired types, which are hidden everywhere else so nobody can file against
  // a policy that has been withdrawn.
  types: ({ includeInactive = false } = {}) =>
    apiFetch(`/leaves/types${includeInactive ? '?includeInactive=true' : ''}`),
  createType: (body) => apiFetch('/leaves/types', { method: 'POST', body }),
  updateType: (code, body) => apiFetch(`/leaves/types/${encodeURIComponent(code)}`, { method: 'PATCH', body }),
  deleteType: (code) => apiFetch(`/leaves/types/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  adjustBalance: (body) => apiFetch('/leaves/balance/adjust', { method: 'POST', body }),
};
export const payrollApi = {
  ...restResource('payroll'),
  // Generates the register for an entire cycle. Idempotent server-side, so a
  // double click cannot produce two payslips for one person.
  run: (cycle) => apiFetch('/payroll/run', { method: 'POST', body: { cycle } }),
  statutoryPreview: (empId, cycle) => {
    const qs = new URLSearchParams(
      Object.entries({ empId, cycle }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/payroll/statutory/preview${qs ? `?${qs}` : ''}`);
  },
};
export const holidaysApi = restResource('holidays');

// Server-side reporting. Every figure here is aggregated in MongoDB over the
// FULL collection for the chosen window — the Analytics page used to compute
// these in the browser from the (100-row capped) attendance list it happened to
// have hydrated, which made the attendance rate wrong for any real company.
export const analyticsApi = {
  overview: ({ from, to, dept } = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ from, to, dept }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/analytics/overview${qs ? `?${qs}` : ''}`);
  },
  // Hiring and attrition for a window. Attrition is returned with its
  // denominator (average headcount), so the rate can be checked rather than
  // taken on trust.
  workforce: ({ from, to } = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ from, to }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/analytics/workforce${qs ? `?${qs}` : ''}`);
  },
  attendanceTrend: ({ from, to } = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ from, to }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/analytics/attendance-trend${qs ? `?${qs}` : ''}`);
  },
};
export const recruitmentApi = {
  ...restResource('recruitment'),
  // Offer management and hiring. Recruitment previously ended at a "Hired"
  // column with nothing turning the candidate into an employee.
  issueOffer: (id, body) => apiFetch(`/recruitment/${id}/offer`, { method: 'POST', body }),
  offerResponse: (id, decision, reason) =>
    apiFetch(`/recruitment/${id}/offer/response`, { method: 'POST', body: { decision, reason } }),
  hire: (id) => apiFetch(`/recruitment/${id}/hire`, { method: 'POST' }),
};
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
  // `overrideClearances` is the explicit, audited way past the server's
  // outstanding-clearance guard (409 CLEARANCES_PENDING).
  payFnF: (id, opts = {}) => apiFetch(`/resignations/${id}/fnf/pay`, {
    method: 'POST',
    body: { overrideClearances: Boolean(opts.overrideClearances) },
  }),
};

export const attendanceCorrectionsApi = {
  list: () => apiFetch('/attendance-corrections'),
  create: (data) => apiFetch('/attendance-corrections', { method: 'POST', body: data }),
  approve: (id) => apiFetch(`/attendance-corrections/${id}/approve`, { method: 'POST' }),
  reject: (id, note) => apiFetch(`/attendance-corrections/${id}/reject`, { method: 'POST', body: { note: note || '' } }),
};

// Celebrations is computed server-side from real Employee dob/joinDate
// (see server/src/routes/celebrations.js) rather than a stored collection —
// only GET (list) and PATCH (send wish) exist as real routes, so those are
// the only methods requested here.
export const celebrationsApi = restResource('celebrations', ['list', 'update']);

export const attendanceApi = {
  ...restResource('attendance'),
  /**
   * Every attendance row the caller is allowed to see, for export.
   *
   * WHY THIS EXISTS: `list()` hits GET /attendance with no paging, and that
   * branch is capped server-side at 100 rows to avoid an OOM on a large
   * dataset. The Attendance page exported whatever was in that hydrated list,
   * so with 100 employees a single working day already fills the cap and every
   * export from then on was SILENTLY truncated - no error, no warning, just
   * missing people. The existing E2E export test could not catch it because
   * its tenant holds fewer rows than the cap.
   *
   * This pages through the server's real paginated branch instead, so an
   * export contains the whole result set. `hardLimit` is a safety valve: it
   * stops a runaway loop rather than silently trimming, and the caller is told
   * when it was hit so nothing is ever quietly dropped again.
   */
  async listAll({ from, to, pageSize = 200, hardLimit = 100000 } = {}) {
    const rows = [];
    let page = 1;
    let total = null;
    let truncated = false;
    for (;;) {
      const qs = new URLSearchParams({ page: String(page), limit: String(pageSize) });
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      // eslint-disable-next-line no-await-in-loop
      const body = await apiFetch(`/attendance?${qs.toString()}`);
      const batch = Array.isArray(body) ? body : (body.rows || []);
      if (total == null) total = Array.isArray(body) ? batch.length : (body.total ?? batch.length);
      rows.push(...batch);
      if (batch.length < pageSize || rows.length >= total) break;
      if (rows.length >= hardLimit) { truncated = true; break; }
      page += 1;
    }
    return { rows, total: total ?? rows.length, truncated };
  },
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

let bootstrapPromise = null;

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
  //
  // SINGLE-FLIGHT. This went straight to apiFetch, bypassing the shared
  // refresh promise in lib/apiClient.js, so two overlapping callers each fired
  // their own POST /auth/refresh. Browser measurement showed the login screen
  // issuing repeated refreshes, every one of them answering 401 and logging a
  // console error, before anybody had typed anything. Concurrent callers now
  // share one request; the promise is released once it settles so a later
  // bootstrap still works.
  bootstrap() {
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        try {
          const data = await apiFetch('/auth/refresh', { method: 'POST', skipAuth: true });
          setAccessToken(data.accessToken);
          return data.user;
        } catch {
          setAccessToken(null);
          return null;
        } finally {
          bootstrapPromise = null;
        }
      })();
    }
    return bootstrapPromise;
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

/**
 * Pages through a list endpoint and returns EVERY row.
 *
 * An unpaged GET returns only the first page (attendance caps at 100), so a
 * CSV built from the app shell's hydrated list silently omitted most of the
 * data while looking like a complete export — the worst kind of wrong, because
 * the person exporting it has no way to tell.
 */
export async function fetchAllRows(resource, { pageSize = 500, max = 50000, params = {} } = {}) {
  const rows = [];
  for (let page = 1; rows.length < max; page += 1) {
    const qs = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
      page: String(page),
      limit: String(pageSize),
    }).toString();
    const res = await apiFetch(`/${resource}?${qs}`);
    const batch = Array.isArray(res) ? res : (res.rows || []);
    rows.push(...batch);
    const total = Array.isArray(res) ? batch.length : res.total;
    if (batch.length < pageSize || rows.length >= (total ?? rows.length)) break;
  }
  return rows;
}

/**
 * EMPLOYMENT LIFECYCLE — confirmation, probation, transfer, promotion and
 * salary revision.
 *
 * These used to be done by PATCHing the employee, which overwrote the previous
 * value with no effective date and no record of who changed it or why. Each
 * call here produces an immutable event alongside the change.
 */
export const lifecycleApi = {
  policy: () => apiFetch('/lifecycle/policy'),
  savePolicy: (body) => apiFetch('/lifecycle/policy', { method: 'PUT', body }),
  events: ({ empId, type, limit } = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ empId, type, limit }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/lifecycle/events${qs ? `?${qs}` : ''}`);
  },
  probationDue: (withinDays) =>
    apiFetch(`/lifecycle/probation/due${withinDays ? `?withinDays=${withinDays}` : ''}`),
  startProbation: (id, body) => apiFetch(`/lifecycle/${id}/probation/start`, { method: 'POST', body }),
  extendProbation: (id, body) => apiFetch(`/lifecycle/${id}/probation/extend`, { method: 'POST', body }),
  confirm: (id, body) => apiFetch(`/lifecycle/${id}/confirm`, { method: 'POST', body }),
  transfer: (id, body) => apiFetch(`/lifecycle/${id}/transfer`, { method: 'POST', body }),
  promote: (id, body) => apiFetch(`/lifecycle/${id}/promote`, { method: 'POST', body }),
  reviseSalary: (id, body) => apiFetch(`/lifecycle/${id}/salary-revision`, { method: 'POST', body }),
};

/**
 * VARIABLE PAY — overtime, bonus, incentive, arrears, reimbursements and
 * ad-hoc deductions for a payroll cycle. Payroll could previously only pay a
 * fixed gross, so none of this could be paid through the system at all.
 *
 * Overtime is claimed in HOURS; the server values it from the employee's own
 * salary and the company's configured multiplier. Sending an amount for
 * overtime has no effect by design.
 */
export const payComponentsApi = {
  list: ({ cycle, empId, status, kind } = {}) => {
    const qs = new URLSearchParams(
      Object.entries({ cycle, empId, status, kind }).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return apiFetch(`/pay-components${qs ? `?${qs}` : ''}`);
  },
  summary: (cycle) => apiFetch(`/pay-components/summary?cycle=${encodeURIComponent(cycle)}`),
  raise: (body) => apiFetch('/pay-components', { method: 'POST', body }),
  decide: (id, decision, note) =>
    apiFetch(`/pay-components/${id}/decision`, { method: 'POST', body: { decision, note } }),
  withdraw: (id) => apiFetch(`/pay-components/${id}`, { method: 'DELETE' }),
};

// Load everything at once for the app shell. Requires an authenticated
// session (employees/attendance/geofence and all 9 modules below are behind
// requireAuth) — only call this after authApi has established a session.
/**
 * Hydrates the app.
 *
 * `role` is optional and, when given, SKIPS the collections that role cannot
 * read anyway. Those endpoints already answered 403 and every call site
 * already fell back to [], so skipping produces an identical result with one
 * fewer round trip. An ordinary employee was previously issuing 20 requests on
 * every load, several of which were guaranteed to be refused.
 *
 * Omitting `role` keeps the original behaviour of fetching everything, so any
 * caller that does not know the role yet is unaffected.
 */
export async function loadAll(role) {
  const may = (path) => !role || canAccess(role, path);
  const isAdmin = !role || role === 'HR Director';
  const skip = () => Promise.resolve([]);
  const [
    employees, attendance, leaves, payroll, celebrations, holidays,
    recruitment, reviews, expenses, assets, jobs,
    settings, roles, masterCategories, masterValues,
    auditLogs, notifications, documents, resignations, attendanceCorrections,
  ] = await Promise.all([
    // EVERY collection is individually guarded.
    //
    // Only the last five used to be, so the moment any other endpoint started
    // refusing a role — as /recruitment did once candidate PII was protected —
    // Promise.all rejected and the ENTIRE app failed to hydrate on login, for
    // that role, with no partial render and no useful error. A collection this
    // user may not see should cost them that panel, never the whole product.
    //
    // `settings` falls back to an object, not an array, because callers read
    // fields off it; the rest are lists.
    employeesApi.list().catch(() => []),
    attendanceApi.list().catch(() => []),
    leavesApi.list().catch(() => []),
    payrollApi.list().catch(() => []),
    celebrationsApi.list().catch(() => []),
    holidaysApi.list().catch(() => []),
    may('/recruitment') ? recruitmentApi.list().catch(() => []) : skip(),
    reviewsApi.list().catch(() => []),
    expensesApi.list().catch(() => []),
    may('/assets') ? assetsApi.list().catch(() => []) : skip(),
    may('/recruitment') ? jobsApi.list().catch(() => []) : skip(),
    settingsApi.get(),
    isAdmin ? rolesApi.list().catch(() => []) : skip(),
    masterCategoriesApi.list().catch(() => []),
    masterValuesApi.list().catch(() => []),
    isAdmin ? auditLogsApi.list().catch(() => []) : skip(),
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
export async function reloadFromDisk(role) {
  return loadAll(role);
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
