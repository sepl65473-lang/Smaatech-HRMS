import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

// Everything here is held in the Android Keystore-backed secure store. The
// password is never stored: only the server-issued refresh token (an opaque,
// revocable value) and a random install identifier.
const REFRESH_TOKEN_KEY = 'hrms.refreshToken';
const DEVICE_ID_KEY = 'hrms.deviceId';
const REMINDER_KEY = 'hrms.checkInReminder';

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    // A keystore that cannot be read (restored backup, key invalidated) is the
    // same as having no session: the user signs in again.
    return null;
  }
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

// Sent with each punch as `deviceId`; the server uses it to flag one device
// punching for several employees. Random per install, not a hardware id.
let cachedDeviceId: string | null = null;
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id: string | null = null;
  try {
    id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  } catch {
    id = null;
  }
  if (!id) {
    id = `android-${Crypto.randomUUID()}`;
    try {
      await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
    } catch {
      // Still usable for this run.
    }
  }
  cachedDeviceId = id;
  return id;
}

export async function getReminderPreference(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REMINDER_KEY);
  } catch {
    return null;
  }
}

export async function setReminderPreference(value: string | null): Promise<void> {
  if (value) await SecureStore.setItemAsync(REMINDER_KEY, value);
  else await SecureStore.deleteItemAsync(REMINDER_KEY);
}
