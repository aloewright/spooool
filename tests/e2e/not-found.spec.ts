import { expect, test } from '@playwright/test';

// ALO-433: pin the SPA 404 view in a real browser.
test.describe('not found page', () => {
  test('shows Page not found, footer links, robots noindex, and home navigation', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to home' })).toBeVisible();

    const footer = page.locator('footer.app-footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Pricing' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'DMCA' })).toBeVisible();

    await expect
      .poll(async () => page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content')))
      .toBe('noindex');

    await page.getByRole('link', { name: 'Go to home' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: /trending this week/i })).toBeVisible();
  });
});
