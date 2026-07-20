import { describe, it, expect } from 'vitest';
import { isStrongPassword, PASSWORD_MIN_LENGTH } from './passwordPolicy.js';

describe('isStrongPassword', () => {
  it('accepts a password with letters, digits, and enough length', () => {
    expect(isStrongPassword('Admin@123')).toBe(true);
  });

  it('rejects a password shorter than the minimum length', () => {
    expect(isStrongPassword('Ab1')).toBe(false);
  });

  it('rejects a digits-only password', () => {
    expect(isStrongPassword('12345678')).toBe(false);
  });

  it('rejects a letters-only password', () => {
    expect(isStrongPassword('abcdefgh')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isStrongPassword(undefined)).toBe(false);
    expect(isStrongPassword(null)).toBe(false);
    expect(isStrongPassword(12345678)).toBe(false);
  });

  it('accepts a password exactly at the minimum length', () => {
    const pw = `a1${'x'.repeat(PASSWORD_MIN_LENGTH - 2)}`;
    expect(pw.length).toBe(PASSWORD_MIN_LENGTH);
    expect(isStrongPassword(pw)).toBe(true);
  });
});
