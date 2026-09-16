import { defineConfig, devices } from '@playwright/test';
import { WEB_BASE, E2E_SECRET } from './e2e/fixtures/harness.js';

/**
 * Browser E2E against a COMPLETE isolated stack: throwaway MongoDB replica
 * set -> the real `node src/index.js` -> the real Vite client. Nothing here
 * touches the live Atlas database.
 *
 * Workers is 1 on purpose: the specs share one seeded tenant and drive real
 * attendance rows, which are unique per employee-day. Running them in
 * parallel would have specs fighting over the same row rather than testing
 * anything.
 */
export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // A single retry, for the browser-level flakes only (a slow first paint on
  // a cold Vite dev server). Assertion failures reproduce on the retry, so a
  // real regression still fails the run.
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB_BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    // Sent on every request the page makes. The server only honours it when
    // E2E_TEST_MODE is on AND NODE_ENV is not production — see
    // server/src/lib/e2eGuard.js. Without it these specs get the normal
    // production paths (OTP email, real face model).
    extraHTTPHeaders: { 'X-E2E-Secret': E2E_SECRET },
    permissions: ['camera', 'geolocation'],
    // The office coordinates the seeded tenant's geofence is centred on.
    geolocation: { latitude: 19.0760, longitude: 72.8777, accuracy: 10 },
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        // A headless browser has no webcam, so getUserMedia would reject and
        // the capture UI could never be driven. Chromium's synthetic device
        // makes the REAL capture path run end to end; the frame it produces
        // has no face in it, which is why the isolated E2E mode substitutes
        // the identity comparison (still enforcing the identity RULE).
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--allow-file-access-from-files',
        ],
      },
    },
  }],
});
