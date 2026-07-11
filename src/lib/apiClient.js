// Thin fetch wrapper for the real backend (server/). Holds the JWT access
// token in memory only (never localStorage) and transparently retries once
// via the httpOnly refresh cookie on a 401, mirroring how a native app would
// eventually use the same endpoints with a bearer token.
const API_BASE = '/api/v1';

let accessToken = null;
let refreshingPromise = null;

export function setAccessToken(token) {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function rawRequest(path, { method = 'GET', body, skipAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!skipAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no/invalid JSON body */ }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code, data?.error?.message || `Request failed (${res.status})`);
  }
  return data;
}

async function refreshAccessToken() {
  if (!refreshingPromise) {
    refreshingPromise = rawRequest('/auth/refresh', { method: 'POST', skipAuth: true })
      .then((data) => { accessToken = data.accessToken; return data; })
      .catch((err) => { accessToken = null; throw err; })
      .finally(() => { refreshingPromise = null; });
  }
  return refreshingPromise;
}

export async function apiFetch(path, opts = {}) {
  try {
    return await rawRequest(path, opts);
  } catch (err) {
    const isAuthRoute = path.startsWith('/auth/');
    if (err instanceof ApiError && err.status === 401 && !opts.skipAuth && !isAuthRoute) {
      await refreshAccessToken();
      return rawRequest(path, opts);
    }
    throw err;
  }
}
