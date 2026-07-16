import { buildSeed } from './seed';
import { uid } from '../lib/helpers';
import { apiFetch, setAccessToken } from '../lib/apiClient';

// ─────────────────────────────────────────────────────────────
//  DATA LAYER
//
//  Employees, Attendance, and the geofence/shift subset of Settings now
//  live on the real backend (server/) — see authApi/employeesApi/
//  attendanceApi/geofenceApi below, which call the REST API directly.
//  Everything else (Leave, Payroll, Celebrations, Recruitment, Reviews,
//  Expenses, Assets, Jobs, and the rest of Settings) still persists to
//  localStorage, same as before, and is still swappable to a real API
//  later the same way this file has always documented:
//
//  ➜ replace the bodies of the methods in `createResource` with `fetch()`
//    calls to your REST API. Nothing else in the app has to change.
// ─────────────────────────────────────────────────────────────

const DB_KEY = 'Smaatech_hrms_db_v1';

// Simulate a little network latency so loading states are real.
const LATENCY = 90;
const wait = (value) => new Promise((res) => setTimeout(() => res(value), LATENCY));
const clone = (v) => JSON.parse(JSON.stringify(v));

function readLocalRaw() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Could not parse stored local DB, reseeding.', err);
    return null;
  }
}

function saveDB(localDb) {
  localStorage.setItem(DB_KEY, JSON.stringify(localDb));
}

// In-memory mirror of the locally-persisted (non-backend) collections.
// Lazily built on first access because seeding it for the first time needs
// the employee roster from the server (see ensureDB below).
let db = null;
let dbReady = null;

async function ensureDB(employeesHint) {
  if (db) return db;
  if (!dbReady) {
    dbReady = (async () => {
      const existing = readLocalRaw();
      if (existing) {
        db = existing;
      } else {
        const employees = employeesHint || await employeesApi.list();
        db = buildSeed(employees);
        saveDB(db);
      }
      return db;
    })();
  }
  return dbReady;
}

// Generic collection resource (local-only collections): list / get / create / update / remove
function createResource(collection) {
  return {
    async list() {
      await ensureDB();
      return wait(clone(db[collection]));
    },
    async get(id) {
      await ensureDB();
      return wait(clone(db[collection].find((x) => x.id === id) || null));
    },
    async create(data) {
      await ensureDB();
      const record = { id: uid(collection.slice(0, 3)), ...data };
      db[collection] = [record, ...db[collection]];
      saveDB(db);
      return wait(clone(record));
    },
    async update(id, patch) {
      await ensureDB();
      let updated = null;
      db[collection] = db[collection].map((x) => {
        if (x.id === id) {
          updated = { ...x, ...patch };
          return updated;
        }
        return x;
      });
      saveDB(db);
      return wait(clone(updated));
    },
    async remove(id) {
      await ensureDB();
      db[collection] = db[collection].filter((x) => x.id !== id);
      saveDB(db);
      return { id };
    },
  };
}

export const leavesApi      = createResource('leaves');
export const payrollApi     = createResource('payroll');
export const celebrationsApi = createResource('celebrations');
export const holidaysApi    = createResource('holidays');
export const recruitmentApi = createResource('recruitment');
export const reviewsApi      = createResource('reviews');
export const expensesApi     = createResource('expenses');
export const assetsApi       = createResource('assets');
export const jobsApi         = createResource('jobs');

// Local-only settings (org config, login profiles/face descriptors,
// notification templates, gateway credentials, etc). The geofence/shift
// subset that attendance verification depends on lives server-side instead —
// see geofenceApi.
export const settingsApi = {
  async get() {
    await ensureDB();
    return wait(clone(db.settings));
  },
  async update(patch) {
    await ensureDB();
    db.settings = { ...db.settings, ...patch };
    saveDB(db);
    return wait(clone(db.settings));
  },
};

// ── Real backend resources ──────────────────────────────────────────────

function restResource(path) {
  return {
    list: () => apiFetch(`/${path}`),
    get: (id) => apiFetch(`/${path}/${id}`),
    create: (data) => apiFetch(`/${path}`, { method: 'POST', body: data }),
    update: (id, patch) => apiFetch(`/${path}/${id}`, { method: 'PATCH', body: patch }),
    remove: (id) => apiFetch(`/${path}/${id}`, { method: 'DELETE' }),
  };
}

export const employeesApi = restResource('employees');

// Real login accounts (Settings > Users & role access). HR Director only —
// deliberately not part of loadAll()/hydrate, since GET /users would 403 for
// every other role; fetched lazily from the Settings page instead.
export const usersApi = restResource('users');

export const attendanceApi = {
  ...restResource('attendance'),
  // The verified self check-in/out path — the server independently re-derives
  // geofence distance and lateness rather than trusting anything in `payload`.
  checkIn: (id, payload) => apiFetch(`/attendance/${id}/check-in`, { method: 'POST', body: payload }),
  checkOut: (id, payload) => apiFetch(`/attendance/${id}/check-out`, { method: 'POST', body: payload }),
};

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
  // Returns { accessToken, user } — caller decides when to commit the
  // session (HRMSContext defers this until any 2FA step finishes).
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true }),
  faceLogin: (email) => apiFetch('/auth/face-login', { method: 'POST', body: { email }, skipAuth: true }),
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
};

// Load everything at once for the app shell. Requires an authenticated
// session (employees/attendance/geofence are all behind requireAuth) — only
// call this after authApi has established a session.
export async function loadAll() {
  const employees = await employeesApi.list();
  const [attendance, local, geofence] = await Promise.all([
    attendanceApi.list(),
    ensureDB(employees),
    geofenceApi.get(),
  ]);
  const localClone = clone(local);
  return {
    employees,
    attendance,
    ...localClone,
    settings: { ...localClone.settings, ...geofence },
  };
}

// Re-reads localStorage into the in-memory mirror (picks up writes made by
// another tab/window of the same browser — see the `storage` event listener
// in HRMSContext) and refetches the server-backed collections, since those
// can now also have changed from a different device entirely.
export async function reloadFromDisk() {
  db = null;
  dbReady = null;
  return loadAll();
}

export const DB_STORAGE_KEY = DB_KEY;

// Wipe the LOCAL (non-backend) collections and rebuild from seed, linked to
// whichever employees currently exist on the server. Employees/Attendance
// themselves live in MongoDB now and are not affected by this (Settings →
// Danger Zone reset was always scoped to this app's own demo data, not a
// shared server database).
export async function resetDB() {
  const employees = await employeesApi.list();
  db = buildSeed(employees);
  saveDB(db);
  dbReady = Promise.resolve(db);
  return loadAll();
}
