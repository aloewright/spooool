import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve(__dirname, "drizzle"));
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            KEYRING_MASTER_KEY: "test-keyring-master-key",
          },
        },
      }),
    ],
    test: {
      include: ["../../tests/integration/**/*.test.ts"],
      setupFiles: ["../../tests/integration/setup.ts"],
    },
  };
});
