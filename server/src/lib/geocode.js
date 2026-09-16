// Reverse-geocodes coordinates into a STRUCTURED address via OpenStreetMap's
// Nominatim service — free, no API key/billing required. Their usage policy
// requires a real identifying User-Agent and caps requests at ~1/sec.
// Best-effort: any failure just means a null address, never a blocked check-in.
//
// Returns an OBJECT, not a flattened string. The previous version collapsed
// everything into one display line ("MG Road, Indiranagar, Bengaluru,
// Karnataka - 560001"), which meant an attendance record could not show, sort
// or filter on place name, postal code or city independently — and an auditor
// reviewing a punch could not tell which part of that blob was the PIN.
// Coordinates are carried alongside, never replaced, because the geofence
// check and any later dispute both need the raw fix.
import logger from './logger.js';

const USER_AGENT = 'SmaatechHRMS/1.0 (attendance check-in address lookup)';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

// Nominatim is rate-limited to roughly 1 request/second by policy. Identical
// coordinates repeat constantly (the same office, every punch, every day), so
// caching by rounded position removes almost all of that traffic.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

// ~11 m of precision: enough to distinguish entrances, coarse enough that
// every punch from one office lands on the same key.
const cacheKeyOf = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Cheap eviction: drop the oldest inserted key.
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Splits a Nominatim address object into the fields an attendance record and
 * an HR reviewer actually need.
 */
export function structureAddress(addr = {}, displayName = null) {
  // The most specific recognisable thing at the coordinates — a building or
  // business name where one exists, otherwise the street.
  const placeName = addr.building || addr.amenity || addr.office || addr.shop
    || addr.industrial || addr.commercial || null;
  const road = [addr.house_number, addr.road || addr.pedestrian].filter(Boolean).join(' ') || null;
  const area = addr.suburb || addr.neighbourhood || addr.residential || addr.quarter || addr.subdistrict || null;
  const city = addr.city || addr.town || addr.village || addr.municipality || addr.city_district || null;
  const district = addr.state_district || addr.county || null;
  const state = addr.state || null;
  const pincode = addr.postcode || null;
  const country = addr.country || null;

  // Full address line, de-duplicated and without the postcode (which is its
  // own field) so the two are never conflated.
  const seen = new Set();
  const fullAddress = [placeName, road, area, city, district, state, country]
    .filter((part) => part && !seen.has(part) && seen.add(part))
    .join(', ') || displayName || null;

  return {
    placeName: placeName || road || area || city || null,
    fullAddress,
    pincode,
    area,
    city,
    district,
    state,
    country,
  };
}

/**
 * @returns {Promise<null | {
 *   placeName, fullAddress, pincode, area, city, district, state, country,
 *   lat, lng, accuracy, resolvedAt, source, display
 * }>}
 */
export async function reverseGeocode(lat, lng, { accuracy = null } = {}) {
  if (lat == null || lng == null) return null;

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  // Out-of-range coordinates are a client bug, not a place.
  if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return null;

  const key = cacheKeyOf(latNum, lngNum);
  const cached = readCache(key);
  const base = {
    lat: latNum,
    lng: lngNum,
    accuracy: accuracy == null ? null : Number(accuracy),
    resolvedAt: new Date().toISOString(),
  };

  if (cached) return { ...cached, ...base, source: 'cache' };

  try {
    const url = `${NOMINATIM_URL}?format=json&lat=${latNum}&lon=${lngNum}&zoom=18&addressdetails=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ...base, ...structureAddress({}, null), source: 'unresolved', display: null };

    const data = await res.json();
    if (!data) return { ...base, ...structureAddress({}, null), source: 'unresolved', display: null };

    const structured = structureAddress(data.address || {}, data.display_name || null);
    // One-line form, kept for existing UI that renders a single string.
    const display = structured.fullAddress && structured.pincode
      ? `${structured.fullAddress} - ${structured.pincode}`
      : (structured.fullAddress || structured.pincode || null);

    const value = { ...structured, display };
    writeCache(key, value);
    return { ...value, ...base, source: 'nominatim' };
  } catch (err) {
    logger.warn('[geocode] reverse geocoding failed: %s', err.message);
    // A geocode failure must never block a punch — the coordinates are still
    // recorded, which is what the geofence decision was actually made on.
    return { ...base, ...structureAddress({}, null), source: 'unresolved', display: null };
  }
}

/**
 * Back-compatible one-line form, for callers that only want a display string.
 */
export async function reverseGeocodeLine(lat, lng) {
  const result = await reverseGeocode(lat, lng);
  return result?.display || null;
}

export function _clearGeocodeCache() {
  cache.clear();
}
