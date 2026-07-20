import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const localPort = baseURL.startsWith("http://localhost") ? new URL(baseURL).port : undefined;

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  // When E2E_BASE_URL points at a remote URL, no webServer is needed.
  ...(localPort
    ? {
        webServer: {
          command: `pnpm --filter web exec vite --host 127.0.0.1 --port ${localPort} --strictPort`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }
    : {}),
});
