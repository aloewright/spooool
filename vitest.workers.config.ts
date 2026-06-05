import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Worker integration tests hit the real Worker entry via SELF.fetch with D1
// migrations applied from src/db/migrations. Unit tests stay in vitest.config.ts.
export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, 'src/db/migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.vitest.toml' },
        miniflare: {
          bindings: {
            CF_STREAM_WEBHOOK_SECRET: 'vitest-webhook-secret',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['src/**/*.workers.test.ts'],
      setupFiles: ['./src/workers/worker-test-apply-migrations.ts'],
    },
  };
});
