import { defineConfig, devices } from '@playwright/test';

/**
 * PRODUCTION smoke, run against the LIVE deployment.
 *
 * Deliberately separate from playwright.config.js, which boots a throwaway
 * database, a local API and a local Vite server. Nothing here is local and
 * nothing is seeded: this drives the real Vercel frontend talking to the real
 * Render API, which is the only way to claim the deployed system works rather
 * than that the source code would work.
 *
 * It carries NO E2E secret header, so the production paths it exercises are
 * the real ones - no OTP bypass, no face stand-in.
 *
 * These specs are UNAUTHENTICATED by design. Signing in needs production test
 * accounts that do not exist yet; when they do, the authenticated four-role
 * smoke belongs here too.
 *
 *   npx playwright test --config=playwright.prod.config.js
 */
const WEB = process.env.PROD_WEB_URL || 'https://smaatech-hrms.vercel.app';

export default defineConfig({
  testDir: './e2e/prod',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // The API is on Render's free tier and sleeps. A first request after idle
  // takes ~34s and answers 503 before it is healthy, so one retry keeps the
  // smoke about the application rather than about the cold start - which is
  // measured explicitly in its own test rather than hidden here.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
