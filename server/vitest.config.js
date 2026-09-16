import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * These are integration tests, not unit tests: each one runs against a real
     * MongoDB, hashes passwords with real bcrypt (deliberately slow, and never
     * weakened for tests), and drives the actual Express app over HTTP.
     *
     * Vitest's 5s default is fine for a single file and too tight for the whole
     * suite on one worker — fixtures that seed four accounts spend several
     * seconds in bcrypt alone, so tests that pass individually were timing out
     * only in the full run. The budget is raised rather than the fixtures
     * hollowed out; a real hang still fails, it just takes 30s to say so.
     */
    testTimeout: 30_000,
    hookTimeout: 600_000, // starting a MongoDB binary the first time
  },
});
