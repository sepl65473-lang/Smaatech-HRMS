import type { ConfigContext, ExpoConfig } from 'expo/config';

// Static configuration (identity, permissions, plugins) lives in app.json so
// that `eas init` can write the project id into it. This file only adds the
// API URL.
//
// The production API the web client already uses (see the repo-root
// vercel.json connect-src). A release build always talks to this unless an
// EAS profile overrides it; a development build may point elsewhere through
// EXPO_PUBLIC_API_BASE_URL. Nothing secret belongs here: the resulting config
// is embedded in the APK and must be treated as public.
const PRODUCTION_API_BASE_URL = 'https://smaatech-hrms-1.onrender.com/api/v1';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  extra: {
    ...config.extra,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL || PRODUCTION_API_BASE_URL,
  },
});
