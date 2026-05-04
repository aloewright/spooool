import { defineConfig } from 'vitest/config';

// Vitest's default `include` glob is too broad — it would pick up
// tests/e2e/*.spec.ts and try to run Playwright tests inside the unit
// runner. Restrict to src/ so unit tests stay separate from E2E.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
