export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_POLICY_MESSAGE = 'Password must be at least 8 characters and include a letter and a number.';

export function isStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) return false;
  return /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}
