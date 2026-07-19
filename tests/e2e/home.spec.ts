import { expect, test } from '@playwright/test';

// ALO-173: smoke tests for the home / discovery surface — fastest signal
// that the SPA shell + trending API are wired and serving.

test.describe('home page', () => {
  test('renders wordmark and trending heading', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/spooool/i);
    // Trending section has a stable accessible label even when the list is empty.
    await expect(page.getByRole('heading', { name: /trending this week/i })).toBeVisible();
  });

  test('shows a sign-in entry point for anonymous users', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  });

  test('does not 5xx on a deep link to a non-existent video', async ({ page }) => {
    const response = await page.goto('/watch/does-not-exist');
    // SPA shell always 200s; the not-found state is rendered client-side.
    expect(response?.status()).toBeLessThan(500);
  });
});
