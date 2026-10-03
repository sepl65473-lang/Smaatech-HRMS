import { apiFetch } from './apiClient';

// Records where the person was when they signed in — AFTER the sign-in has
// already succeeded, and only if they allow the browser to share it. Nothing
// here can fail or delay a sign-in: every outcome, including a refusal, is
// reported to the server as-is and any error is swallowed. The readable
// address is resolved by the server from the raw coordinates.
const LOCATION_TIMEOUT_MS = 10000;

function readPosition() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ status: 'unavailable' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
      // code 1 = the person (or the browser's settings) refused.
      (err) => resolve({ status: err?.code === 1 ? 'denied' : 'unavailable' }),
      // maximumAge 0: a new fix, never one the browser cached earlier.
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

export async function reportLoginLocation() {
  try {
    const body = await readPosition();
    await apiFetch('/auth/login-location', { method: 'POST', body });
  } catch {
    // Visibility only — a failure here must never surface as a sign-in problem.
  }
}
