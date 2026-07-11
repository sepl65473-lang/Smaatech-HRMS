const EARTH_RADIUS_M = 6371e3;
const toRad = (deg) => (deg * Math.PI) / 180;

// Same formula as the frontend's getDistanceMeters (src/pages/MyDashboard.jsx) —
// kept in lock-step so client and server agree on distance, only the server's
// result is ever trusted for enforcement.
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

const MAX_ACCEPTABLE_ACCURACY_M = 100;
const MAX_FIX_AGE_MS = 30_000;

// Independently re-derives geofence pass/fail from raw coordinates the client
// submitted — never trusts a client-reported isInside/distance value.
export function evaluateGeofence({ lat, lng, accuracy, timestamp }, geofence) {
  if (lat == null || lng == null) {
    return { ok: false, reason: 'NO_COORDINATES' };
  }
  if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
    return { ok: false, reason: 'LOW_ACCURACY', accuracy };
  }
  if (timestamp != null && Date.now() - Number(timestamp) > MAX_FIX_AGE_MS) {
    return { ok: false, reason: 'STALE_FIX' };
  }
  const distance = haversineMeters(lat, lng, geofence.geofenceLat, geofence.geofenceLng);
  const inside = distance <= geofence.geofenceRadius;
  return { ok: inside, reason: inside ? null : 'OUTSIDE_GEOFENCE', distance, inside };
}
