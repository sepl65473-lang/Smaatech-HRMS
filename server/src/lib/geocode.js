// Reverse-geocodes coordinates into a human-readable address via OpenStreetMap's
// Nominatim service — free, no API key/billing required. Their usage policy
// requires a real identifying User-Agent and caps requests at ~1/sec; fine for
// this app's volume (a couple of check-ins per employee per day).
// Best-effort: any failure just means a null address, never a blocked check-in.
const USER_AGENT = 'SmaatechHRMS/1.0 (attendance check-in address lookup)';

export async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (err) {
    console.warn('[geocode] reverse geocoding failed:', err.message);
    return null;
  }
}
