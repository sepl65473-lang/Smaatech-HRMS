import * as Location from 'expo-location';

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number;
}

export class LocationError extends Error {
  code: 'PERMISSION_DENIED' | 'PERMISSION_BLOCKED' | 'SERVICES_OFF' | 'UNAVAILABLE' | 'MOCKED';

  constructor(code: LocationError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// The server rejects a fix older than 30 s (server/src/lib/geofence.js), so a
// reading is reused only while it is comfortably inside that window.
export const FIX_MAX_AGE_MS = 15_000;
const FIX_TIMEOUT_MS = 25_000;

/**
 * A fresh, real GPS reading. Every self check-in/out must carry one
 * (routes/attendance.js validateCoordinates), with or without geofencing.
 * The server re-validates the coordinates and the geofence itself; this only
 * obtains them and explains device-side failures.
 */
export async function getFreshFix(): Promise<Fix> {
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Location.requestForegroundPermissionsAsync();
  }
  if (!permission.granted) {
    throw permission.canAskAgain
      ? new LocationError('PERMISSION_DENIED', 'Location permission is needed to record where you check in or out.')
      : new LocationError('PERMISSION_BLOCKED', 'Location permission is turned off for this app. Enable it in Settings to check in or out.');
  }

  if (!(await Location.hasServicesEnabledAsync())) {
    // Shows the system "turn on location" dialog where Play services allow it.
    await Location.enableNetworkProviderAsync().catch(() => undefined);
    if (!(await Location.hasServicesEnabledAsync())) {
      throw new LocationError('SERVICES_OFF', 'Location is switched off on this phone. Turn it on and try again.');
    }
  }

  let position: Location.LocationObject;
  try {
    position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), FIX_TIMEOUT_MS)),
    ]);
  } catch {
    throw new LocationError('UNAVAILABLE', 'Could not get a GPS reading. Move near a window or outdoors and try again.');
  }

  if (position.mocked) {
    throw new LocationError('MOCKED', 'A mock location app is active. Turn it off to record attendance.');
  }

  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy ?? null,
    timestamp: position.timestamp,
  };
}
