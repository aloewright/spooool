import { defineConfig } from 'vitest/config';

// Vitest's default `include` glob is too broad — it would pick up
// tests/e2e/*.spec.ts and try to run Playwright tests inside the unit
// runner. Restrict to src/ + the small set of test files alongside our
// node scripts. E2E specs live under tests/e2e/ and are excluded.
//
// Tests that need a DOM (e.g. mounting React components to assert error
// boundaries fire) opt in per-file via `// @vitest-environment happy-dom`.
// Everything else stays on the default node environment so the suite is
// fast.
export default defineConfig({
  test: {
    // Force test NODE_ENV so React uses its development build (and act() works)
    // even when the host shell exports NODE_ENV=production.
    env: {
      NODE_ENV: 'test',
    },
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.test.{js,mjs,ts}',
    ],
  },
});
