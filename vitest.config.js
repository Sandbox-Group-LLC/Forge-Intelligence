import { defineConfig } from 'vitest/config';

// Dedicated vitest config so the test runner does NOT load vite.config.ts (the
// React app build). Node environment — current tests are pure source scans.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
