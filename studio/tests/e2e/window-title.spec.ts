import { expect, test } from "@playwright/test";

test("Studio uses the Editor window title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Editor");
});
