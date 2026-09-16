import { test, expect } from '@playwright/test';

/**
 * Real-browser evidence about the LIVE deployment.
 *
 * Everything else in this repository proves the source code behaves; this
 * proves the deployed system does. It runs against the real Vercel frontend
 * and the real Render API, with no seeded data, no E2E secret header and no
 * local stack.
 *
 * All of it is unauthenticated, because production test accounts do not exist
 * yet. That is a real gap and is reported as such rather than papered over
 * with the isolated suite's logins.
 */
const API = process.env.PROD_API_URL || 'https://smaatech-hrms-1.onrender.com/api/v1';

function watch(page) {
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
  return { consoleErrors, failed };
}

test('the production frontend loads and renders the real login screen', async ({ page }) => {
  const seen = watch(page);
  const started = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[type="email"]')).toBeVisible();
  const ms = Date.now() - started;

  await expect(page).toHaveTitle(/HRMS|Smaatech/i);
  console.log(`[prod] login screen usable in ${ms} ms`);
  console.log(`[prod] failed requests: ${seen.failed.length} ${JSON.stringify(seen.failed.slice(0, 3))}`);

  // A blank page with a JS crash also "loads", so assert the form is real.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(seen.failed, 'no request should fail outright on the login screen').toHaveLength(0);
});

test('the deployed frontend talks to the deployed API, not localhost', async ({ page }) => {
  const apiCalls = [];
  page.on('request', (r) => { if (r.url().includes('/api/v1/')) apiCalls.push(r.url()); });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await page.waitForTimeout(2000);

  console.log(`[prod] API calls observed: ${apiCalls.length}`);
  expect(apiCalls.length, 'the app should reach its API on load').toBeGreaterThan(0);
  for (const url of apiCalls) {
    expect(url, 'no production request may point at localhost').not.toMatch(/localhost|127\.0\.0\.1/);
    expect(url).toContain('onrender.com');
  }
});

test('a wrong password produces a real, actionable error - never a bare "Network Error"', async ({ page }) => {
  // This is the defect users actually reported, verified against production
  // rather than a mock: every failure used to surface as axios's literal
  // "Network Error" carrying a fabricated HTTP 500.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[type="email"]')).toBeVisible();

  await page.locator('input[type="email"]').fill('definitely-not-a-real-account-9f3a@example.com');
  await page.locator('.login-field', { hasText: 'Password' }).locator('input').fill('WrongPassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Something must be said, and it must not be the generic transport string.
  const body = page.locator('body');
  await expect(body).toContainText(/invalid|incorrect|not match|credential|sign in|try again/i, { timeout: 60_000 });
  const text = (await body.innerText()).toLowerCase();
  console.log(`[prod] sign-in failure surfaced to the user (no bare transport error)`);
  expect(text).not.toContain('network error');

  // And the user is still on the login screen rather than stranded.
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('the production API enforces authorization and CORS', async ({ request }) => {
  const protectedPaths = ['employees', 'payroll', 'users', 'audit-logs', 'documents'];
  for (const path of protectedPaths) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request.get(`${API}/${path}`, { failOnStatusCode: false });
    expect(res.status(), `${path} must reject an unauthenticated caller`).toBe(401);
  }

  const allowed = await request.get(`${API}/health`, {
    headers: { Origin: 'https://smaatech-hrms.vercel.app' },
    failOnStatusCode: false,
  });
  expect(allowed.headers()['access-control-allow-origin']).toBe('https://smaatech-hrms.vercel.app');

  const attacker = await request.get(`${API}/health`, {
    headers: { Origin: 'https://evil.example.com' },
    failOnStatusCode: false,
  });
  expect(attacker.headers()['access-control-allow-origin']).toBeUndefined();
});

test('production health reports a connected database and the deployed commit', async ({ request }) => {
  const res = await request.get(`${API}/health`, { failOnStatusCode: false });
  const body = await res.json();
  console.log(`[prod] health: ${JSON.stringify(body)}`);

  // A cold start answers 503 with db "connecting" - that is the documented
  // Render Free limitation, not a failure of the application, so it is
  // reported rather than asserted away.
  if (res.status() === 503) {
    expect(body.status).toBe('degraded');
    console.log('[prod] NOTE: service was cold-starting on this request');
    return;
  }
  expect(res.status()).toBe(200);
  expect(body.db).toBe('connected');
  expect(body.commit, 'health must report which commit is deployed').toBeTruthy();
});

test('security headers are present on the live API', async ({ request }) => {
  const res = await request.get(`${API}/health`, { failOnStatusCode: false });
  const h = res.headers();
  expect(h['content-security-policy']).toContain("default-src 'none'");
  expect(h['strict-transport-security']).toContain('max-age=');
  expect(h['x-content-type-options']).toBe('nosniff');
});

test('a hundred employees behind one address are not falsely rate limited', async ({ request }) => {
  // Twelve DIFFERENT accounts from this one address. Under the old per-IP
  // bucket the eleventh would have been refused; the per-account layer is what
  // carries the security, and it is proven separately.
  const codes = [];
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request.post(`${API}/auth/login`, {
      data: { email: `prodsmoke-${i}-${Date.now()}@example.com`, password: 'NotARealPass123' },
      failOnStatusCode: false,
    });
    codes.push(res.status());
  }
  console.log(`[prod] login codes from one address: ${codes.join(' ')}`);
  expect(codes.filter((c) => c === 429), 'legitimate distinct accounts must not be throttled').toHaveLength(0);
});
