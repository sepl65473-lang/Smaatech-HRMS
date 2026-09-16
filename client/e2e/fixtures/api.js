import { E2E_SECRET } from './harness.js';

/**
 * Calls the API as the CURRENTLY SIGNED-IN browser user.
 *
 * The app holds its access token in module memory rather than localStorage, so
 * a fetch issued from page.evaluate carries no Authorization header. The
 * httpOnly refresh cookie the browser already has is exchanged for a fresh
 * access token first — exactly what the application itself does on page load.
 * This stays inside the real session; it never mints credentials.
 *
 * Used for assertions ABOUT state and for negative authorization checks. The
 * user-facing workflows are always driven through the UI.
 */
export async function apiAs(page, method, path, body) {
  // The app navigates as it hydrates, and an evaluate that starts mid-navigation
  // dies with "Execution context was destroyed". Waiting for the document, and
  // retrying once, makes this an assertion about the API rather than about
  // whether the SPA happened to be settling at that instant.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  try {
    return await evaluateRequest(page, method, path, body);
  } catch (err) {
    if (!/Execution context was destroyed|frame was detached/i.test(String(err?.message))) throw err;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return evaluateRequest(page, method, path, body);
  }
}

function evaluateRequest(page, method, path, body) {
  return page.evaluate(async ({ method, path, body, secret }) => {
    const refreshed = await fetch('/api/v1/auth/refresh', {
      method: 'POST', credentials: 'include', headers: { 'X-E2E-Secret': secret },
    });
    if (!refreshed.ok) return { status: refreshed.status, body: { error: { code: 'NO_SESSION' } } };
    const { accessToken } = await refreshed.json();

    const res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-E2E-Secret': secret,
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { method, path, body, secret: E2E_SECRET });
}
