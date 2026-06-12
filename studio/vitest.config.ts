import { defineConfig } from "vitest/config";
import path from "node:path";

const deps = process.env.DEPS_PATH || path.resolve(".", "node_modules");

export default defineConfig({
  resolve: {
    alias: {
      hono: `${deps}/hono`,
      "drizzle-orm": `${deps}/drizzle-orm`,
      "@aws-sdk/client-s3": `${deps}/@aws-sdk/client-s3`,
      "@hono/node-server": `${deps}/@hono/node-server`,
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
