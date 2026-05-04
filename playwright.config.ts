import { defineConfig, devices } from '@playwright/test';

// ALO-173: Playwright targets a running app. Two operating modes:
//
// - **Local**: leave PLAYWRIGHT_BASE_URL unset; the config starts `npm run dev`
//   (vite + wrangler dev) and runs against http://localhost:5173.
//
// - **Staging / preview**: set PLAYWRIGHT_BASE_URL to the deployed URL
//   (e.g. https://spooool-preview.workers.dev). The webServer is skipped so
//   we don't double-start. This is how the GitHub Actions workflow runs E2E
//   against the staging deployment after each push to main.
//
// Tests should be **idempotent and tolerant of pre-existing data** — they
// run against shared environments and can't assume an empty DB.

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const isLocal = !process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // Fail the build in CI if anyone forgets to remove a `.only` from a test.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile Safari coverage matters because our HLS path branches on native
    // HLS support (Safari uses native; everywhere else uses hls.js — ALO-204).
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: isLocal
    ? {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        // vite + wrangler dev cold-start can take a while.
        timeout: 120_000,
      }
    : undefined,
});
