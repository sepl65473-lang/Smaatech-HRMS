// describePunchLocation builds the readable location stored on a punch. These
// pin the two rules that matter: the company name appears only for a punch
// genuinely inside the configured site, and nothing is ever made up.
import { describe, it, expect } from 'vitest';
import { describePunchLocation } from './geofence.js';

const SITE = { orgName: 'Smaatech Engineering Pvt Ltd', geofenceLat: 20.27332, geofenceLng: 85.87778, geofenceRadius: 60 };
const geo = (overrides = {}) => ({
  placeName: 'Saheednagar',
  fullAddress: 'Saheednagar, Khordha, Odisha, India',
  display: 'Saheednagar, Khordha, Odisha, India - 751025',
  ...overrides,
});

describe('describePunchLocation — company site', () => {
  it('names the company and keeps the specific address for a punch at the site coordinates', () => {
    const out = describePunchLocation(geo(), { lat: 20.27332, lng: 85.87778, accuracy: 12 }, SITE);
    expect(out.atSite).toBe(true);
    expect(out.address).toBe('Smaatech Engineering Pvt Ltd, Saheednagar, Khordha, Odisha, India - 751025');
  });

  it('names the company for a punch a few metres away but inside the radius', () => {
    // ~35 m north of the site point.
    const out = describePunchLocation(geo(), { lat: 20.27363, lng: 85.87778, accuracy: 15 }, SITE);
    expect(out.atSite).toBe(true);
  });

  it('does NOT name the company for a punch elsewhere in the same city', () => {
    // ~340 m away: same locality, same geocoded address, not the office.
    const out = describePunchLocation(geo(), { lat: 20.27027, lng: 85.87702, accuracy: 15 }, SITE);
    expect(out.atSite).toBe(false);
    expect(out.address).toBe('Saheednagar, Khordha, Odisha, India - 751025');
  });

  it('still names the company when the address lookup failed, without inventing an address', () => {
    const out = describePunchLocation(null, { lat: 20.27332, lng: 85.87778, accuracy: 10 }, SITE);
    expect(out.address).toBe('Smaatech Engineering Pvt Ltd');
  });

  it('never names a site that is not configured', () => {
    for (const settings of [{ ...SITE, orgName: '  ' }, { ...SITE, geofenceRadius: 0 }, { orgName: 'X' }, null]) {
      expect(describePunchLocation(geo(), { lat: 20.27332, lng: 85.87778, accuracy: 10 }, settings).atSite).toBe(false);
    }
  });
});

describe('describePunchLocation — away from the site', () => {
  it('keeps the place the geocoder resolved, unchanged', () => {
    const cafe = geo({ placeName: 'Cafe Coffee Day', fullAddress: 'Cafe Coffee Day, Janpath, Bhubaneswar, Odisha, India', display: 'Cafe Coffee Day, Janpath, Bhubaneswar, Odisha, India - 751001' });
    const out = describePunchLocation(cafe, { lat: 20.2961, lng: 85.8245, accuracy: 20 }, SITE);
    expect(out.atSite).toBe(false);
    expect(out.address).toBe('Cafe Coffee Day, Janpath, Bhubaneswar, Odisha, India - 751001');
  });

  it('a city-only result stays city-only', () => {
    const out = describePunchLocation(geo({ placeName: 'Puri', fullAddress: 'Puri, Odisha, India', display: 'Puri, Odisha, India' }), { lat: 19.8, lng: 85.83, accuracy: 30 }, SITE);
    expect(out.address).toBe('Puri, Odisha, India');
  });

  it('returns no address at all when geocoding is unavailable', () => {
    const out = describePunchLocation(null, { lat: 19.8, lng: 85.83, accuracy: 30 }, SITE);
    expect(out).toEqual({ address: null, atSite: false });
  });
});

describe('describePunchLocation — precision', () => {
  it('marks a coarse fix as approximate and does not claim the company site from it', () => {
    const out = describePunchLocation(geo(), { lat: 20.27332, lng: 85.87778, accuracy: 2000 }, SITE);
    expect(out.atSite).toBe(false);
    expect(out.address).toBe('Saheednagar, Khordha, Odisha, India - 751025 (approximate, within 2000 m)');
  });

  it('treats a fix with no reported accuracy as given, with no approximate marker', () => {
    const out = describePunchLocation(geo(), { lat: 20.27332, lng: 85.87778, accuracy: null }, SITE);
    expect(out.atSite).toBe(true);
    expect(out.address).not.toContain('approximate');
  });
});
