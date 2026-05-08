import { expect, test } from '@playwright/test';

// ALO-173: smoke tests for the home / discovery surface — fastest signal
// that the SPA shell + landing surface are wired and serving.
// ALO-177: anonymous visitors land on the marketing page; the trending feed
// is only rendered for signed-in sessions.

test.describe('home page', () => {
  test('renders the marketing landing for anonymous visitors', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/spooool/i);
    // Hero <h1> is the LCP candidate and ships in the eager bundle.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/upload, stream, share/i);
    await expect(page.getByRole('heading', { level: 2, name: /why spooool/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /see it in action/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /get a channel in 30 seconds/i })).toBeVisible();
  });

  test('shows the primary signup CTA', async ({ page }) => {
    await page.goto('/');
    // Hero's primary CTA routes into /signup. Use the first match — the
    // landing renders a second "Create your channel" CTA below the fold.
    const signupCta = page.getByRole('link', { name: /sign up free/i }).first();
    await expect(signupCta).toBeVisible();
    await signupCta.click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('does not 5xx on a deep link to a non-existent video', async ({ page }) => {
    const response = await page.goto('/watch/does-not-exist');
    // SPA shell always 200s; the not-found state is rendered client-side.
    expect(response?.status()).toBeLessThan(500);
  });
});
