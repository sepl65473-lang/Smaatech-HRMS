import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Device from 'expo-device';
import { API_BASE_URL, APP_VERSION, DEFAULT_TIMEOUT_MS } from '../config/env';
import { clearRefreshToken, getRefreshToken, setRefreshToken } from '../storage/secure';
import type { User } from '../types';

// The web client keeps its refresh token in an httpOnly cookie scoped to
// /api/v1/auth (server/src/lib/tokens.js). A native app has no browser cookie
// jar worth trusting with that, so the same cookie is handled explicitly: it
// is read from the Set-Cookie header, kept in the Keystore-backed secure store,
// and sent back as a Cookie header on /auth calls only. The server is
// unchanged and cannot tell the two clients apart.
const REFRESH_COOKIE = 'sepl_refresh';

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  /** True when the request never produced an HTTP response. */
  isTransport: boolean;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.isTransport = status === 0;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was rejected as invalid.',
  401: 'Your session has ended. Please sign in again.',
  403: 'You do not have permission to do that.',
  404: 'That item no longer exists.',
  409: 'That conflicts with the current state. Refresh and try again.',
  413: 'That file is too large to upload.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'The server hit an unexpected error. Nothing was saved.',
  502: 'The server is not reachable right now. Try again shortly.',
  503: 'The service is starting up or temporarily unavailable. Try again in a moment.',
  504: 'The server took too long to respond. Try again shortly.',
};

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshing: Promise<User> | null = null;
let sessionActive = false;
let sessionLostHandler: ((error: ApiError) => void) | null = null;

export function setSessionLostHandler(handler: ((error: ApiError) => void) | null) {
  sessionLostHandler = handler;
}

export function getAccessToken() {
  return accessToken;
}

function notifySessionLost(error: ApiError) {
  if (!sessionActive) return;
  sessionActive = false;
  accessToken = null;
  void clearRefreshToken();
  sessionLostHandler?.(error);
}

// The server derives the punch's device record from this header
// (server/src/lib/deviceInfo.js), so it names the real handset.
const USER_AGENT = `Mozilla/5.0 (Linux; Android ${Device.osVersion ?? Platform.Version}; ${Device.modelName ?? 'Android'}) SmaatechHRMS/${APP_VERSION}`;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the bearer token (sign-in, password reset). */
  anonymous?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  let url = `${API_BASE_URL}${path}`;
  if (query) {
    const parts = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    if (parts.length) url += `?${parts.join('&')}`;
  }
  return url;
}

function extractRefreshCookie(response: Response): string | null {
  const header = response.headers.get('set-cookie');
  if (!header) return null;
  const match = new RegExp(`${REFRESH_COOKIE}=([^;,\\s]+)`).exec(header);
  return match && match[1] ? match[1] : null;
}

async function rawFetch(path: string, opts: RequestOptions, extraHeaders: Record<string, string> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...extraHeaders,
  };
  if (accessToken && !opts.anonymous) headers.Authorization = `Bearer ${accessToken}`;
  // For multipart the runtime must set Content-Type itself, boundary included.
  if (!opts.form && opts.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      // The platform cookie jar is never used: the refresh cookie is managed
      // explicitly above and must not leak into ordinary API calls.
      credentials: 'omit',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

async function transportError(err: unknown, opts: RequestOptions): Promise<ApiError> {
  if (opts.signal?.aborted) return new ApiError(0, 'CANCELLED', 'The request was cancelled.');
  if ((err as { name?: string })?.name === 'AbortError') {
    return new ApiError(0, 'TIMEOUT', 'The server did not respond in time. It may be starting up — please try again in a moment.');
  }
  const net = await NetInfo.fetch().catch(() => null);
  if (net && net.isConnected === false) {
    return new ApiError(0, 'OFFLINE', 'Your phone is offline. Reconnect and try again.');
  }
  // A real network failure is raised by the fetch layer as "fetch failed: …"
  // (or the classic "Network request failed"). Anything else was thrown while
  // the request was still being put together — a file that could not be read,
  // a body that could not be built — so nothing was sent, and calling that
  // "could not reach the server" would point the user at the wrong problem.
  const message = err instanceof Error ? err.message : '';
  if (err instanceof Error && !/^fetch failed|network request failed/i.test(message)) {
    return new ApiError(0, 'REQUEST_NOT_SENT', 'The request could not be prepared on this phone, so nothing was sent. Please try again.');
  }
  return new ApiError(0, 'UNREACHABLE', 'Could not reach the server. It may be starting up — please try again in a moment.');
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string } } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body?.error?.code || `HTTP_${response.status}`;
  const message = body?.error?.message || STATUS_MESSAGES[response.status] || `The server returned an error (HTTP ${response.status}).`;
  const retryAfter = Number(response.headers.get('retry-after'));
  return new ApiError(response.status, code, message, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}

// Render's free tier sleeps an idle service; its proxy answers 502/503 with a
// non-JSON body while the API boots. Those are waited out rather than shown.
const WAKE_RETRY_DELAYS_MS = [2000, 4000, 6000, 8000, 10000, 10000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isProxyWakeResponse(response: Response) {
  if (response.status !== 502 && response.status !== 503) return false;
  try {
    const body = await response.clone().json();
    return !body?.error; // our own envelope means the API is awake
  } catch {
    return true;
  }
}

async function fetchWithWakeRetry(path: string, opts: RequestOptions, extraHeaders?: Record<string, string>): Promise<Response> {
  const method = opts.method ?? 'GET';
  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < WAKE_RETRY_DELAYS_MS.length;
    try {
      const response = await rawFetch(path, opts, extraHeaders);
      // A proxy 502/503 means the API never saw the request, so replaying it
      // is safe for every method.
      if (canRetry && (await isProxyWakeResponse(response))) {
        await sleep(WAKE_RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return response;
    } catch (err) {
      const error = await transportError(err, opts);
      // A dropped connection may or may not have reached the server. Only a
      // read is replayed; a write is surfaced so the caller can re-check state.
      const retriable = method === 'GET' && error.code === 'UNREACHABLE';
      if (!canRetry || !retriable) throw error;
      await sleep(WAKE_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function authCookieHeader(): Promise<Record<string, string>> {
  const token = await getRefreshToken();
  return token ? { Cookie: `${REFRESH_COOKIE}=${token}` } : {};
}

// Read only to schedule a refresh ahead of expiry; the server still verifies
// the signature on every request.
function readExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function adoptSession(response: Response): Promise<User> {
  const data = (await response.json()) as { accessToken?: string; user?: User };
  const refresh = extractRefreshCookie(response);
  if (!data?.accessToken || !data.user || !refresh) {
    throw new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent an unexpected sign-in response. Please try again.');
  }
  await setRefreshToken(refresh);
  accessToken = data.accessToken;
  accessTokenExpiresAt = readExpiry(data.accessToken);
  sessionActive = true;
  return data.user;
}

/** Password sign-in. `identifier` is an email address or a registered mobile number. */
export async function signIn(identifier: string, password: string): Promise<User> {
  const value = identifier.trim();
  const byEmail = value.includes('@');
  const response = await fetchWithWakeRetry(byEmail ? '/auth/login' : '/auth/login-mobile', {
    method: 'POST',
    anonymous: true,
    body: byEmail ? { email: value.toLowerCase(), password } : { mobile: value, password },
  });
  if (!response.ok) throw await toApiError(response);
  return adoptSession(response);
}

/** Exchanges the stored refresh token for a new session. Rotates the token. */
export function refreshSession(): Promise<User> {
  if (!refreshing) {
    refreshing = (async () => {
      const cookie = await authCookieHeader();
      if (!cookie.Cookie) throw new ApiError(401, 'NO_REFRESH', 'Not signed in.');
      const response = await fetchWithWakeRetry('/auth/refresh', { method: 'POST', anonymous: true, body: {} }, cookie);
      if (!response.ok) throw await toApiError(response);
      return adoptSession(response);
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function signOut(): Promise<void> {
  const cookie = await authCookieHeader();
  sessionActive = false;
  accessToken = null;
  await clearRefreshToken();
  try {
    // Best effort: revokes the refresh token server-side. The local session is
    // already gone whether or not this reaches the server.
    await rawFetch('/auth/logout', { method: 'POST', anonymous: true, body: {}, timeoutMs: 8000 }, cookie);
  } catch {
    // Offline sign-out still clears the device.
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  // /auth routes identify "this session" by the refresh cookie (for example
  // change-password keeps the current session and revokes the others).
  const isAuthRoute = path.startsWith('/auth/');

  // Renew a token that is about to expire before sending, so a photo upload is
  // not sent once to be refused and then a second time after the refresh.
  if (!opts.anonymous && accessToken && accessTokenExpiresAt - Date.now() < 30_000) {
    try {
      await refreshSession();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        notifySessionLost(err);
        throw err;
      }
      // Unreachable: let the request itself report that.
    }
  }

  const extra = isAuthRoute ? await authCookieHeader() : undefined;

  let response = await fetchWithWakeRetry(path, opts, extra);

  if (response.status === 401 && !opts.anonymous && !isAuthRoute) {
    try {
      await refreshSession();
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError(0, 'UNREACHABLE', 'Could not reach the server.');
      // Only the server refusing the refresh token ends the session; a network
      // failure says nothing about whether it is still valid.
      if (error.status === 401 || error.status === 403) notifySessionLost(error);
      throw error;
    }
    response = await fetchWithWakeRetry(path, opts, extra);
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.code === 'ACCOUNT_DISABLED' && !opts.anonymous) notifySessionLost(error);
    throw error;
  }

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(0, 'MALFORMED_RESPONSE', 'The server sent a response this app could not read. Please try again.');
  }
}

/** Authenticated absolute URL + headers, for image components and downloads. */
export function authorizedSource(path: string) {
  return {
    uri: `${API_BASE_URL}${path}`,
    headers: { Authorization: `Bearer ${accessToken ?? ''}`, 'User-Agent': USER_AGENT },
  };
}

/** Guarantees a non-expired access token before a call that cannot be replayed through `request` (downloads, images). */
export async function ensureFreshToken(): Promise<void> {
  if (accessToken && accessTokenExpiresAt - Date.now() > 60_000) return;
  try {
    await refreshSession();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) notifySessionLost(err);
    throw err;
  }
}

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.') {
  return err instanceof ApiError ? err.message : fallback;
}
