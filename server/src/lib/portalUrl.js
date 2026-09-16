/**
 * The HRMS address onboarding emails send a new employee to.
 *
 * Its own module, not part of lib/mailer.js, because the health route needs it
 * too and pulling the mailer in there would drag Brevo and the EmailLog model
 * into a route whose whole job is to answer cheaply for a load balancer.
 *
 * WHY IT EXISTS AT ALL: the welcome template carried a hardcoded default and
 * nothing passed an override, so every onboarding email shipped a sign-in
 * button aimed at one fixed domain regardless of where the deployment lives.
 * That domain was verified unreachable, which means each new employee received
 * a dead link.
 *
 * CLIENT_ORIGIN is the right source: it is already the deployed frontend
 * origin and production refuses to start without it (see lib/startupChecks.js).
 * The first entry is used when several are configured, since the rest are
 * staging or preview origins. APP_PORTAL_URL overrides it when the address
 * employees should open differs from the CORS origin.
 *
 * Returns null rather than inventing an address; the template then omits the
 * button instead of shipping something broken.
 */
export function portalUrl(env = process.env) {
  const explicit = (env.APP_PORTAL_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const first = (env.CLIENT_ORIGIN || '').split(',')[0].trim();
  if (first) return first.replace(/\/$/, '');
  return null;
}
