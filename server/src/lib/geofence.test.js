// describePunchLocation builds the readable location stored for a punch or a
// sign-in. These pin the rules that matter: it is the actual resolved place,
// the same everywhere, nothing is made up, and a coarse fix is not presented
// as exact.
import { describe, it, expect } from 'vitest';
import { describePunchLocation } from './geofence.js';

const geo = (overrides = {}) => ({
  placeName: 'Saheednagar',
  fullAddress: 'Saheednagar, Khordha, Odisha, India',
  display: 'Saheednagar, Khordha, Odisha, India - 751025',
  ...overrides,
});

describe('describePunchLocation — the actual place, with no special cases', () => {
  it('returns the resolved address as it is', () => {
    expect(describePunchLocation(geo(), { accuracy: 12 })).toEqual({ address: 'Saheednagar, Khordha, Odisha, India - 751025' });
  });

  it('never substitutes or prefixes a company name, even when a site is configured at the same point', () => {
    const site = { orgName: 'Smaatech Engineering Pvt Ltd', geofenceLat: 20.27332, geofenceLng: 85.87778, geofenceRadius: 60 };
    // A third argument is ignored: there is no company-site logic.
    const out = describePunchLocation(geo(), { lat: 20.27332, lng: 85.87778, accuracy: 12 }, site);
    expect(out.address).toBe('Saheednagar, Khordha, Odisha, India - 751025');
    expect(out.address).not.toContain('Smaatech');
    expect(out).not.toHaveProperty('atSite');
  });

  it('keeps a named place the geocoder resolved', () => {
    const cafe = geo({ display: 'Cafe Coffee Day, Janpath, Bhubaneswar, Odisha, India - 751001' });
    expect(describePunchLocation(cafe, { accuracy: 20 }).address).toBe('Cafe Coffee Day, Janpath, Bhubaneswar, Odisha, India - 751001');
  });

  it('a city-only result stays city-only', () => {
    expect(describePunchLocation(geo({ display: 'Puri, Odisha, India' }), { accuracy: 30 }).address).toBe('Puri, Odisha, India');
  });

  it('returns no address at all when geocoding is unavailable', () => {
    expect(describePunchLocation(null, { accuracy: 30 })).toEqual({ address: null });
  });
});

describe('describePunchLocation — precision', () => {
  it('marks a coarse fix as approximate', () => {
    expect(describePunchLocation(geo(), { accuracy: 2000 }).address)
      .toBe('Saheednagar, Khordha, Odisha, India - 751025 (approximate, within 2000 m)');
  });

  it('adds no marker for a precise fix or one with no reported accuracy', () => {
    expect(describePunchLocation(geo(), { accuracy: 100 }).address).not.toContain('approximate');
    expect(describePunchLocation(geo(), { accuracy: null }).address).not.toContain('approximate');
  });
});
