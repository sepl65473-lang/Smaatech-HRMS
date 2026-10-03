import * as Location from 'expo-location';
import { request } from '../services/api';

// Records where the person was when they signed in — AFTER the sign-in has
// already succeeded, and only if they allow it. Nothing here can fail or delay
// a sign-in: a refusal is reported to the server as a refusal, and every error
// is swallowed. The readable address is resolved by the server from the raw
// coordinates; the app never composes one.
const FIX_TIMEOUT_MS = 15_000;

type LoginLocationBody =
  | { lat: number; lng: number; accuracy: number | null; timestamp: number }
  | { status: 'denied' | 'unavailable' };

async function readPosition(): Promise<LoginLocationBody> {
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Location.requestForegroundPermissionsAsync();
  }
  if (!permission.granted) return { status: 'denied' };
  if (!(await Location.hasServicesEnabledAsync())) return { status: 'unavailable' };
  try {
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), FIX_TIMEOUT_MS)),
    ]);
    // A mock-location app's position is not where the person is.
    if (position.mocked) return { status: 'unavailable' };
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
      timestamp: position.timestamp,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function reportLoginLocation(): Promise<void> {
  try {
    const body = await readPosition();
    await request('/auth/login-location', { method: 'POST', body });
  } catch {
    // Visibility only — never a sign-in problem.
  }
}
