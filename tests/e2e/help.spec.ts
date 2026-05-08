import { expect, test } from '@playwright/test';

// ALO-183: smoke tests for the help center / creator docs surface.

test.describe('help center', () => {
  test('renders the index with the four advertised articles', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: /help center/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /quickstart/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /upload guide/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /encoding tips/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /monetization faq/i })).toBeVisible();
  });

  test('search filters the article list', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('searchbox', { name: /search help articles/i }).fill('stripe');
    // Stripe is only mentioned in the monetization article.
    await expect(page.getByRole('link', { name: /monetization faq/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /encoding tips/i })).not.toBeVisible();
  });

  test('opens a single article and links back to the index', async ({ page }) => {
    await page.goto('/help/quickstart');
    await expect(page.getByRole('heading', { name: /^quickstart$/i })).toBeVisible();
    await page.getByRole('link', { name: /help center/i }).first().click();
    await expect(page).toHaveURL(/\/help$/);
  });

  test('homepage footer surfaces the help link', async ({ page }) => {
    await page.goto('/');
    const helpLink = page.locator('footer').getByRole('link', { name: /^help$/i });
    await expect(helpLink).toBeVisible();
  });
});
