import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount whatever the previous test rendered so effects/timers from one
// test can't leak console warnings or state into the next.
afterEach(() => {
  cleanup();
});
