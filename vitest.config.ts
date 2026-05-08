import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.join(here, 'src/db/migrations');

// Two-project layout (ALO-189):
//
// 1. `unit` — existing co-located *.test.ts under src/ + scripts/, run on
//    Node like before. Vitest's default `include` glob is too broad so we
//    keep the previous explicit list. E2E specs under tests/e2e/ stay out
//    of the unit runner — they're driven by Playwright.
//
// 2. `integration` — new tests/integration/**/*.test.ts run inside the
//    Workers runtime via `@cloudflare/vitest-pool-workers`. They get real
//    miniflare bindings (D1, R2, KV, Queue) with D1 migrations applied
//    from src/db/migrations before the suite. The test entry worker at
//    tests/integration/worker.ts mounts videoRoutes with a stub session
//    middleware so we can drive the routes without booting better-auth.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'src/**/*.{test,spec}.{ts,tsx}',
            'scripts/**/*.test.{js,mjs,ts}',
          ],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './tests/integration/worker.ts',
            miniflare: {
              compatibilityDate: '2024-03-29',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              r2Buckets: ['VIDEOS'],
              kvNamespaces: ['CACHE', 'SESSIONS'],
              queueProducers: { VIDEO_ENCODING: 'video-encoding' },
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
              },
            },
          }),
        ],
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['./tests/integration/setup.ts'],
        },
      },
    ],
  },
});
