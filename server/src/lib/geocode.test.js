// structureAddress turns a Nominatim reverse-geocode response into the
// attendance record's address fields. These pin two things: every level of
// detail the provider actually returned survives into the readable address,
// and nothing the provider did NOT return is ever made up.
import { describe, it, expect } from 'vitest';
import { structureAddress } from './geocode.js';

// Shape of a real Nominatim `address` object for a point in Patia, Bhubaneswar.
const PATIA = {
  house_number: '12',
  road: 'Infocity Road',
  neighbourhood: 'Chandaka Industrial Estate',
  suburb: 'Patia',
  city: 'Bhubaneswar',
  state_district: 'Khordha',
  state: 'Odisha',
  postcode: '751024',
  country: 'India',
};

describe('structureAddress — provider detail is kept', () => {
  it('keeps every locality level, the road and the house number', () => {
    const out = structureAddress(PATIA, null, null);
    expect(out.fullAddress).toBe(
      '12 Infocity Road, Chandaka Industrial Estate, Patia, Bhubaneswar, Khordha, Odisha, India',
    );
    expect(out.pincode).toBe('751024');
    expect(out.city).toBe('Bhubaneswar');
    expect(out.district).toBe('Khordha');
    expect(out.state).toBe('Odisha');
    expect(out.country).toBe('India');
  });

  it('puts the provider\'s top-level place name first and uses it as placeName', () => {
    const out = structureAddress(PATIA, null, 'Infocity Tower A');
    expect(out.placeName).toBe('Infocity Tower A');
    expect(out.fullAddress.startsWith('Infocity Tower A, 12 Infocity Road, ')).toBe(true);
  });

  it('keeps a tagged building / business name', () => {
    const out = structureAddress({ ...PATIA, building: 'Fortune Towers' });
    expect(out.placeName).toBe('Fortune Towers');
    expect(out.fullAddress.startsWith('Fortune Towers, 12 Infocity Road')).toBe(true);
  });

  it('keeps floor and unit only when the provider returned them', () => {
    const withUnit = structureAddress({ ...PATIA, unit: '4B', floor: '3' });
    expect(withUnit.fullAddress.startsWith('Unit 4B, Floor 3, 12 Infocity Road')).toBe(true);

    const without = structureAddress(PATIA);
    expect(without.fullAddress).not.toMatch(/Unit|Floor/);
  });

  it('keeps city_district and other locality levels alongside the city', () => {
    const out = structureAddress({
      road: 'MG Road', quarter: 'Sector 3', residential: 'Green Park',
      city_district: 'North Zone', city: 'Bengaluru', state: 'Karnataka',
    });
    expect(out.fullAddress).toBe('MG Road, Green Park, Sector 3, North Zone, Bengaluru, Karnataka');
  });

  it('keeps the existing single-value fields exactly as before', () => {
    const out = structureAddress(PATIA);
    // `area` still holds one representative locality (suburb first).
    expect(out.area).toBe('Patia');
    expect(Object.keys(out).sort()).toEqual(
      ['area', 'city', 'country', 'district', 'fullAddress', 'pincode', 'placeName', 'state'],
    );
  });
});

describe('structureAddress — nothing is invented', () => {
  it('leaves out every level the provider did not return', () => {
    const out = structureAddress({ road: 'Janpath', city: 'Bhubaneswar', state: 'Odisha', country: 'India' });
    expect(out.fullAddress).toBe('Janpath, Bhubaneswar, Odisha, India');
    expect(out.pincode).toBeNull();
    expect(out.district).toBeNull();
    expect(out.area).toBeNull();
  });

  it('a city-only response stays city-only', () => {
    const out = structureAddress({ city: 'Bhubaneswar', state: 'Odisha', country: 'India' }, null, 'Bhubaneswar');
    expect(out.fullAddress).toBe('Bhubaneswar, Odisha, India');
    expect(out.placeName).toBe('Bhubaneswar');
  });

  it('removes duplicated components, ignoring case and spacing', () => {
    const out = structureAddress({
      road: 'Patia', suburb: 'patia', city: 'Bhubaneswar ', city_district: 'Bhubaneswar', state: 'Odisha',
    }, null, 'PATIA');
    expect(out.fullAddress).toBe('PATIA, Bhubaneswar, Odisha');
  });

  it('ignores blank and non-string values', () => {
    const out = structureAddress({ road: '  ', suburb: '', house_number: 42, city: 'Cuttack' }, null, '   ');
    expect(out.fullAddress).toBe('Cuttack');
    expect(out.placeName).toBe('Cuttack');
  });

  it('falls back to the provider\'s display_name only when nothing structured was returned', () => {
    expect(structureAddress({}, 'Somewhere, Odisha, India').fullAddress).toBe('Somewhere, Odisha, India');
    expect(structureAddress({ city: 'Puri' }, 'Somewhere else').fullAddress).toBe('Puri');
  });

  it('returns all-null fields for an empty or missing response', () => {
    for (const input of [{}, null, undefined]) {
      const out = structureAddress(input, null, null);
      expect(out).toEqual({
        placeName: null, fullAddress: null, pincode: null, area: null,
        city: null, district: null, state: null, country: null,
      });
    }
  });
});

// The exact `address` object Nominatim returns for the company's own office
// coordinates (20.2733, 85.8778): the locality arrives under `county`.
describe('structureAddress — locality returned as county', () => {
  const OFFICE = {
    county: 'Saheednagar', state_district: 'Khordha', state: 'Odisha',
    postcode: '751025', country: 'India', country_code: 'in',
  };

  it('keeps the locality instead of collapsing to district and state', () => {
    const out = structureAddress(OFFICE, 'Saheednagar, Khordha, Odisha, 751025, India', '');
    expect(out.fullAddress).toBe('Saheednagar, Khordha, Odisha, India');
    expect(out.placeName).toBe('Saheednagar');
    expect(out.district).toBe('Khordha');
    expect(out.pincode).toBe('751025');
  });

  it('still treats county as the district when there is no state_district, without repeating it', () => {
    const out = structureAddress({ county: 'Rayagada', state: 'Odisha', country: 'India' }, null, null);
    expect(out.district).toBe('Rayagada');
    expect(out.fullAddress).toBe('Rayagada, Odisha, India');
    expect(out.placeName).toBeNull();
  });
});
