import { defineConfig } from 'vitest/config';

// Vitest's default `include` glob is too broad — it would pick up
// tests/e2e/*.spec.ts and try to run Playwright tests inside the unit
// runner. Restrict to src/ + the small set of test files alongside our
// node scripts. E2E specs live under tests/e2e/ and are excluded.
export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.test.{js,mjs,ts}',
    ],
  },
});
