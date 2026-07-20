import { describe, it, expect } from 'vitest';
import {
  formatINR, daysBetween, initials, leaveTagClass, leaveTagLabel, parseHolidayDay,
} from './helpers.js';

describe('formatINR', () => {
  it('formats a whole number with Indian digit grouping', () => {
    expect(formatINR(50000)).toBe('₹ 50,000');
  });
  it('defaults a missing amount to zero', () => {
    expect(formatINR()).toBe('₹ 0');
  });
  it('treats a falsy amount as zero', () => {
    expect(formatINR(0)).toBe('₹ 0');
  });
});

describe('daysBetween', () => {
  it('counts a single day as 1 (inclusive)', () => {
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(1);
  });
  it('counts a multi-day range inclusively', () => {
    expect(daysBetween('2026-08-01', '2026-08-03')).toBe(3);
  });
  it('returns 0 when the range is missing a date', () => {
    expect(daysBetween('', '2026-08-01')).toBe(0);
    expect(daysBetween('2026-08-01', '')).toBe(0);
  });
  it('returns 0 rather than negative when end precedes start', () => {
    expect(daysBetween('2026-08-03', '2026-08-01')).toBe(0);
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Priya Sharma')).toBe('PS');
  });
  it('takes a single letter for a one-word name', () => {
    expect(initials('Madonna')).toBe('M');
  });
  it('ignores a third+ word', () => {
    expect(initials('Ananya Rao Nair')).toBe('AR');
  });
  it('returns an empty string for empty input', () => {
    expect(initials('')).toBe('');
  });
});

describe('leaveTagClass / leaveTagLabel', () => {
  it('maps a known leave type to its class and label', () => {
    expect(leaveTagClass('sick')).toBe('tag-sick');
    expect(leaveTagLabel('sick')).toBe('Sick leave');
  });
  it('falls back to casual/generic for an unknown type', () => {
    expect(leaveTagClass('unknown')).toBe('tag-casual');
    expect(leaveTagLabel('unknown')).toBe('Leave');
  });
});

describe('parseHolidayDay', () => {
  it('parses a "D Mon" style string into day + zero-indexed month', () => {
    expect(parseHolidayDay('7 Jun, Sun')).toEqual({ day: 7, month: 5 });
  });
  it('returns null for an unparseable string', () => {
    expect(parseHolidayDay('not a date')).toBeNull();
    expect(parseHolidayDay('')).toBeNull();
  });
});
