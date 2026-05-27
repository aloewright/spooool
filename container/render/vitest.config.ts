import { defineConfig } from 'vitest/config';

// Local vitest config for the render container. Picks up tests in both
// src/ (server-side code) and remotion/ (composition unit tests).
export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'remotion/**/*.{test,spec}.{ts,tsx}',
    ],
  },
});
