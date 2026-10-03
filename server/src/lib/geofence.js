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

// Reads one raw request value as a coordinate: null when it was not supplied,
// NaN when it was supplied but is not a number. Number() alone is not enough —
// it turns '' and [] into 0, which is a real place off the coast of Africa.
export function parseCoordinate(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

// Independent of geofencing: is this a position on Earth at all? Runs whether
// or not the geofence is enabled, so "NaN, NaN" or latitude 123 is never stored.
export function validateCoordinates(lat, lng) {
  if (lat == null || lng == null) {
    return { ok: false, reason: 'NO_COORDINATES' };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, reason: 'INVALID_COORDINATES' };
  }
  return { ok: true, reason: null };
}

const MAX_ACCEPTABLE_ACCURACY_M = 100;

/**
 * The one-line readable address recorded for one punch (checkInAddress /
 * checkOutAddress — what HR and the employee see), built only from what the
 * server holds: the reverse-geocoded address and the company site already
 * configured in Settings (orgName + geofenceLat/Lng/Radius).
 *
 * The company name is added ONLY when the punch's own coordinates fall inside
 * the configured site radius and the fix is precise enough to say so; a punch
 * anywhere else keeps the address of where it actually happened. This never
 * accepts or rejects a punch — that remains evaluateGeofence(), and only when
 * geofencing is enabled.
 */
export function describePunchLocation(geo, { lat, lng, accuracy }, settings) {
  const precise = accuracy == null || accuracy <= MAX_ACCEPTABLE_ACCURACY_M;
  const siteName = typeof settings?.orgName === 'string' ? settings.orgName.trim() : '';
  const siteLat = Number(settings?.geofenceLat);
  const siteLng = Number(settings?.geofenceLng);
  const siteRadius = Number(settings?.geofenceRadius);
  const atSite = Boolean(siteName) && precise
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Number.isFinite(siteLat) && Number.isFinite(siteLng) && siteRadius > 0
    && haversineMeters(lat, lng, siteLat, siteLng) <= siteRadius;

  const resolved = geo?.display || null;
  let address = atSite ? [siteName, resolved].filter(Boolean).join(', ') : resolved;
  // A coarse fix is recorded as given, but never presented as exact.
  if (address && !precise) address = `${address} (approximate, within ${Math.round(accuracy)} m)`;

  return { address, atSite };
}
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
