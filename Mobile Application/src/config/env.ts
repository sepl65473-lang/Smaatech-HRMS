import Constants from 'expo-constants';

const configured = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl;

if (!configured) {
  throw new Error('apiBaseUrl is missing from the app config.');
}

export const API_BASE_URL = configured.replace(/\/$/, '');

// A release build must never talk to a development machine or over plain HTTP.
// Failing loudly at startup beats an APK that silently points at nothing.
if (!__DEV__ && !/^https:\/\/(?!localhost|127\.|10\.|192\.168\.)/.test(API_BASE_URL)) {
  throw new Error('Release builds require a public HTTPS API base URL.');
}

export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

// Generous enough for a face check-in while the Render instance is busy.
export const DEFAULT_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 90_000;
