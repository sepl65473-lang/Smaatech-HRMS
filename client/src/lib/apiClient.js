import axios from 'axios';

const PRODUCTION_API_URL = 'https://smaatech-hrms-1.onrender.com/api/v1';
const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? PRODUCTION_API_URL : '/api/v1');

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

// Shared Axios Instance
export const axiosInstance = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request Interceptor: attach Bearer token
axiosInstance.interceptors.request.use(
  (config) => {
    if (accessToken && !config.skipAuth) {
      config.headers.Authorization = `Bearer ${accessToken}`;
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

    const status = error.response?.status || 500;
    const code = error.response?.data?.error?.code || 'UNKNOWN_ERROR';
    const message = error.response?.data?.error?.message || error.message || 'Request failed';

    return Promise.reject(new ApiError(status, code, message));
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
    headers: isFormData ? { 'Content-Type': 'multipart/form-data' } : opts.headers,
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
