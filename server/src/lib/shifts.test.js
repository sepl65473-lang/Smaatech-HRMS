import { describe, it, expect } from 'vitest';
import { isLate, isEarlyExit } from './shifts.js';

const GENERAL = { start: '09:00', end: '18:00', graceMins: 15 };
const NIGHT = { start: '22:00', end: '06:00', graceMins: 15 }; // crosses midnight

describe('isLate — same-day shift (General 09:00-18:00, 15min grace)', () => {
  it('on time is not late', () => {
    expect(isLate('09:00', GENERAL)).toBe(false);
  });
  it('early is not late', () => {
    expect(isLate('08:45', GENERAL)).toBe(false);
  });
  it('exactly at the grace cutoff is not late', () => {
    expect(isLate('09:15', GENERAL)).toBe(false);
  });
  it('one minute past the grace cutoff is late', () => {
    expect(isLate('09:16', GENERAL)).toBe(true);
  });
});

describe('isEarlyExit — same-day shift (General 09:00-18:00)', () => {
  it('leaving exactly on time is not an early exit', () => {
    expect(isEarlyExit('18:00', GENERAL)).toBe(false);
  });
  it('leaving one minute early is an early exit', () => {
    expect(isEarlyExit('17:59', GENERAL)).toBe(true);
  });
  it('leaving after shift end is not an early exit', () => {
    expect(isEarlyExit('18:30', GENERAL)).toBe(false);
  });
});

describe('isLate — overnight shift (Night 22:00-06:00, 15min grace)', () => {
  it('on time is not late', () => {
    expect(isLate('22:00', NIGHT)).toBe(false);
  });
  it('shortly after start, within grace, is not late', () => {
    expect(isLate('22:10', NIGHT)).toBe(false);
  });
  it('past grace, same calendar day, is late', () => {
    expect(isLate('23:00', NIGHT)).toBe(true);
  });
  // The bug this function exists to fix: a plain string compare would treat
  // "00:30" as earlier than "22:15" even though it is hours *after* it.
  it('after-midnight check-in is correctly treated as very late, not early', () => {
    expect(isLate('00:30', NIGHT)).toBe(true);
  });
  it('check-in just before shift end (next calendar day) is late', () => {
    expect(isLate('05:59', NIGHT)).toBe(true);
  });
});

describe('isEarlyExit — overnight shift (Night 22:00-06:00)', () => {
  it('leaving exactly at shift end (next calendar day) is not early', () => {
    expect(isEarlyExit('06:00', NIGHT)).toBe(false);
  });
  it('leaving shortly before shift end is an early exit', () => {
    expect(isEarlyExit('05:30', NIGHT)).toBe(true);
  });
  // Same wraparound bug as above, mirrored for checkout: leaving at 23:00
  // (same calendar day as check-in) is barely into the shift — a real early exit.
  it('leaving on the same calendar day as check-in is a large early exit', () => {
    expect(isEarlyExit('23:00', NIGHT)).toBe(true);
  });
  it('leaving after shift end (next calendar day) is not early', () => {
    expect(isEarlyExit('07:00', NIGHT)).toBe(false);
  });
});
