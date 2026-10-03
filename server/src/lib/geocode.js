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

// A provider value worth showing: a non-empty string, trimmed. Anything else
// is treated as absent — never replaced with a guess.
const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Splits a Nominatim address object into the fields an attendance record and
 * an HR reviewer actually need.
 *
 * Every part comes from the provider's own response; a level it did not
 * return is simply left out. `providerName` is the response's top-level
 * `name` — the named thing at the coordinates (a building, campus or shop),
 * which is often the most specific label available and is not repeated
 * inside `address`.
 */
export function structureAddress(addr = {}, displayName = null, providerName = null) {
  addr = addr || {};
  const name = clean(providerName);
  // A building or business name where the provider tagged one.
  const building = clean(addr.building) || clean(addr.amenity) || clean(addr.office) || clean(addr.shop)
    || clean(addr.industrial) || clean(addr.commercial) || clean(addr.house_name);
  // Floor / unit only when actually returned (OSM rarely maps them).
  const unit = clean(addr.unit) || clean(addr.flats);
  const floor = clean(addr.floor) || clean(addr.level);
  const road = [clean(addr.house_number), clean(addr.road) || clean(addr.pedestrian)].filter(Boolean).join(' ') || null;
  // Field kept as before: one representative locality.
  const area = clean(addr.suburb) || clean(addr.neighbourhood) || clean(addr.residential)
    || clean(addr.quarter) || clean(addr.subdistrict);
  // Every locality level returned, finest first, for the readable address.
  // Where the provider returns both, `state_district` is the district and
  // `county` is the finer level beneath it — in India often the locality
  // itself ("Saheednagar" under "Khordha"). It was being dropped, leaving
  // only district and state. When `state_district` is absent, `county` is
  // the district (below) and is not repeated here.
  const localities = [addr.neighbourhood, addr.residential, addr.quarter, addr.suburb, addr.city_district, addr.subdistrict,
    clean(addr.state_district) ? addr.county : null]
    .map(clean);
  const city = clean(addr.city) || clean(addr.town) || clean(addr.village) || clean(addr.municipality)
    || clean(addr.city_district);
  const district = clean(addr.state_district) || clean(addr.county);
  const state = clean(addr.state);
  const pincode = clean(addr.postcode);
  const country = clean(addr.country);

  // Full address line, de-duplicated (case-insensitively) and without the
  // postcode (which is its own field) so the two are never conflated.
  const seen = new Set();
  const fullAddress = [
    unit && `Unit ${unit}`, floor && `Floor ${floor}`,
    name, building, road, ...localities, city, district, state, country,
  ]
    .filter((part) => {
      if (!part) return false;
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ') || clean(displayName);

  return {
    placeName: name || building || road || area || city || (clean(addr.state_district) ? clean(addr.county) : null) || null,
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

    const structured = structureAddress(data.address || {}, data.display_name || null, data.name || null);
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
