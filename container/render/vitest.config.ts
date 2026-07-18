import { defineConfig } from 'vitest/config';

// Local vitest config for the render container. Picks up tests in src/
// (server-side code), remotion/ (composition unit tests), and scripts/
// (deterministic asset generators).
export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'remotion/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{js,mjs,ts}',
    ],
  },
});
