import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  define: {
    // Ensure React loads its development/test build even when the shell
    // environment has NODE_ENV=production (e.g. CI deploy environments).
    'process.env.NODE_ENV': '"test"',
  },
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.test.{js,mjs,ts}',
      'container/render/src/**/*.test.ts',
    ],
    exclude: ['src/**/*.workers.test.ts'],
    restoreMocks: true,
    // cloudflare:workers is a Cloudflare-runtime-only module; stub it out so
    // unit tests that transitively import @cloudflare/containers can still run.
    alias: {
      'cloudflare:workers': path.resolve(
        __dirname,
        'src/__mocks__/cloudflare-workers.ts',
      ),
      // container/render/src/encode.ts imports the AWS S3 client, whose deps
      // live in the container's own node_modules (not installed at the repo
      // root in CI). Root tests only touch pure helpers, so stub the client.
      '@aws-sdk/client-s3': path.resolve(
        __dirname,
        'src/__mocks__/aws-sdk-client-s3.ts',
      ),
    },
  },
});
