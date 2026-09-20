/**
 * Mobile numbers are typed by people, so the same phone is stored in a dozen
 * shapes: "+91 98765 43210", "098765-43210", "9876543210". Employee.phone is a
 * free-text field and always has been, so matching one for sign-in has to
 * compare the NUMBER, not the string.
 *
 * The comparison key is the last 10 digits, which is the subscriber number in
 * India (and the part a person actually knows). A country code, a leading 0,
 * spaces, dashes and brackets therefore all stop mattering. Anything with
 * fewer than 10 digits has no key: it cannot identify an account, and a login
 * attempt carrying one is rejected rather than matched loosely.
 */
export function mobileKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}
