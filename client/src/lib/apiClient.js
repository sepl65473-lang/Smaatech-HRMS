import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

let accessToken = null;
let refreshingPromise = null;

export function setAccessToken(token) {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // 0 means the request never reached the server (transport failure), which
    // is a genuinely different situation from any HTTP status.
    this.isTransport = status === 0;
    if (extra.retryAfterSeconds != null) this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

// No timeout at all meant a hung connection produced a spinner that never
// resolved - the request simply stayed pending forever with nothing to catch.
// Generous enough for the slowest legitimate call (a face check-in under load,
// or a large export), and overridable per request.
const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 60000;

// Shared Axios Instance
export const axiosInstance = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  timeout: DEFAULT_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request Interceptor: attach Bearer token and strip default Content-Type for FormData
axiosInstance.interceptors.request.use(
  (config) => {
    if (accessToken && !config.skipAuth) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    if (config.data instanceof FormData && config.headers) {
      delete config.headers['Content-Type'];
      delete config.headers['content-type'];
    }
    return config;
  },
  (error) => Promise.reject(error)
);

async function refreshAccessToken() {
  if (!refreshingPromise) {
    refreshingPromise = axiosInstance
      .post('/auth/refresh', {}, { skipAuth: true })
      .then((res) => {
        accessToken = res.data.accessToken;
        return res.data;
      })
      .catch((err) => {
        accessToken = null;
        throw err;
      })
      .finally(() => {
        refreshingPromise = null;
      });
  }
  return refreshingPromise;
}

// Response Interceptor: handle 401 & retry
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthRoute = originalRequest.url && originalRequest.url.startsWith('/auth/');
    
    if (error.response?.status === 401 && !originalRequest._retry && !originalRequest.skipAuth && !isAuthRoute) {
      originalRequest._retry = true;
      try {
        await refreshAccessToken();
        if (accessToken) {
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        }
        return axiosInstance(originalRequest);
      } catch (refreshErr) {
        return Promise.reject(refreshErr);
      }
    }

    // The server answered: use ITS status, code and message. Reporting a real
    // 403/409/422 as something else hides the only useful information there is.
    if (error.response) {
      const status = error.response.status;
      const body = error.response.data?.error;
      const code = body?.code || `HTTP_${status}`;
      let message = body?.message;

      if (!message) {
        // A status the API answered but without our JSON envelope (a proxy
        // page, an upstream error). Say which one, rather than "Request
        // failed".
        message = {
          400: 'The request was rejected as invalid.',
          401: 'Your session has ended. Please sign in again.',
          403: 'You do not have permission to do that.',
          404: 'That item no longer exists.',
          409: 'That conflicts with the current state. Refresh and try again.',
          413: 'That file is too large to upload.',
          422: 'Some of the details supplied are not valid.',
          429: 'Too many requests. Please wait a moment and try again.',
          500: 'The server hit an unexpected error. Nothing was saved.',
          502: 'The server is not reachable right now. Try again shortly.',
          503: 'The service is starting up or temporarily unavailable. Try again in a moment.',
          504: 'The server took too long to respond. Try again shortly.',
        }[status] || `The server returned an error (HTTP ${status}).`;
      }

      // Honour the server's own back-off hint so the UI can say how long, and
      // so nothing retries into a limiter that has already said no.
      let retryAfterSeconds;
      const retryAfter = error.response.headers?.['retry-after'];
      if (retryAfter != null && retryAfter !== '') {
        const parsed = Number(retryAfter);
        if (Number.isFinite(parsed)) retryAfterSeconds = parsed;
      }

      return Promise.reject(new ApiError(status, code, message, { retryAfterSeconds }));
    }

    // No response at all. axios labels ALL of these "Network Error", which is
    // what users kept seeing and what told them nothing: a timeout, an offline
    // laptop, a sleeping server and a blocked origin are four different
    // problems with four different actions. Status 0 marks "never reached the
    // server" rather than pretending it was an HTTP 500.
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return Promise.reject(new ApiError(0, 'TIMEOUT',
        'The server did not respond in time. It may be starting up — please try again in a moment.'));
    }
    if (error.code === 'ERR_CANCELED') {
      return Promise.reject(new ApiError(0, 'CANCELLED', 'The request was cancelled.'));
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.reject(new ApiError(0, 'OFFLINE',
        'Your device is offline. Reconnect and try again.'));
    }
    return Promise.reject(new ApiError(0, 'UNREACHABLE',
      'Could not reach the server. It may be starting up or temporarily unavailable — please try again in a moment.'));
  }
);

// Backwards-compatible helper
export async function apiFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toLowerCase();
  const isFormData = opts.body instanceof FormData;

  const config = {
    method,
    url: path,
    data: opts.body,
    skipAuth: opts.skipAuth,
    // For FormData, don't set Content-Type at all — the browser derives it
    // itself from the body, including the multipart boundary parameter a
    // manual 'multipart/form-data' string would be missing. Without a real
    // boundary the server can't parse the body at all (busboy throws
    // "Multipart: Boundary not found"), silently failing every photo upload
    // that goes through this path (check-in/out, face enroll, face login,
    // documents).
    headers: isFormData ? undefined : opts.headers,
  };

  const response = await axiosInstance(config);
  return response.data;
}

export async function apiFetchBlob(path, opts = {}) {
  const response = await axiosInstance({
    method: 'GET',
    url: path,
    responseType: 'blob',
    ...opts,
  });
  return response.data;
}
