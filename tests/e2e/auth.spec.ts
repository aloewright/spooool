import { expect, test } from '@playwright/test';

// ALO-173: authenticated-flow smoke. Signup creates a fresh account each
// run with a UUID-suffixed email so reruns against the same environment
// don't clash. Login round-trips through better-auth and reaches a
// signed-in surface.
//
// These tests share the same shared environment; they don't clean up users
// after themselves (deletion lives behind the 30-day grace window from
// ALO-132). The cron sweeps eventually evict them.

const PASSWORD = 'playwright-e2e-password-1';

function uniqueEmail(): string {
  // Crypto.randomUUID is available in Node 18+ and Playwright's runtime.
  const id = crypto.randomUUID().slice(0, 8);
  return `e2e+${id}@spooool-e2e.test`;
}

test.describe('signup → home', () => {
  test('a new user can sign up and lands signed-in on the home page', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/signup');
    await page.getByLabel(/name/i).fill('E2E User');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await Promise.all([
      page.waitForURL('**/'),
      page.getByRole('button', { name: /sign up|create account/i }).click(),
    ]);
    // Signed-in surface should expose an upload entry point.
    await expect(page.getByRole('link', { name: /upload/i })).toBeVisible();
  });

  test('signing in with bad credentials surfaces an error and stays on /login', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('does-not-exist@spooool-e2e.test');
    await page.getByLabel(/password/i).fill('wrong-password');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('alert').or(page.getByText(/invalid|incorrect|wrong/i))).toBeVisible();
  });
});
