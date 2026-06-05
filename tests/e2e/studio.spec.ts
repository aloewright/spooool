import { expect, test } from '@playwright/test';

// ALO-652: gated studio smoke — requires auth; skip unless explicitly enabled.
const enabled = process.env.PLAYWRIGHT_STUDIO === '1';

test.describe('studio', () => {
  test.skip(!enabled, 'Set PLAYWRIGHT_STUDIO=1 to run authenticated studio e2e');

  test('loads the studio shell with animated video, chat, and image sections', async ({ page }) => {
    await page.goto('/studio');
    await expect(page.getByRole('heading', { name: 'Animated video' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Image generation' })).toBeVisible();
  });
});
