import { describe, it, expect } from 'vitest';
import { workedMinutesBetween, formatWorkedMinutes } from './workingHours.js';

describe('workedMinutesBetween', () => {
  it('measures an ordinary day', () => {
    expect(workedMinutesBetween('09:15', '18:00')).toBe(525);
  });

  it('wraps a night shift across midnight instead of going negative', () => {
    expect(workedMinutesBetween('22:00', '06:30')).toBe(510);
  });

  it('has nothing to report until both punches exist', () => {
    expect(workedMinutesBetween('09:15', null)).toBeNull();
    expect(workedMinutesBetween(null, '18:00')).toBeNull();
    expect(workedMinutesBetween(null, null)).toBeNull();
  });

  it('refuses times it cannot read rather than inventing a total', () => {
    expect(workedMinutesBetween('9 AM', '6 PM')).toBeNull();
    expect(workedMinutesBetween('25:00', '18:00')).toBeNull();
    expect(workedMinutesBetween('09:75', '18:00')).toBeNull();
  });
});

describe('formatWorkedMinutes', () => {
  it('reads as hours and minutes', () => {
    expect(formatWorkedMinutes(525)).toBe('8h 45m');
    expect(formatWorkedMinutes(60)).toBe('1h 00m');
    expect(formatWorkedMinutes(0)).toBe('0h 00m');
  });

  it('stays empty when there is no total, so a report shows a blank cell', () => {
    expect(formatWorkedMinutes(null)).toBe('');
  });
});
