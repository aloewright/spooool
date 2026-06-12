import { expect, test } from "@playwright/test";

test("landing page introduces Book Cook and core workflow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Book Cook", exact: true })).toBeVisible();
  await expect(page.getByText(/Plan, draft, edit, and package a book/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a book" })).toBeVisible();

  for (const feature of [
    "Scout evidence",
    "Voice library",
    "Outline builder",
    "Chapter drafting",
    "Full-book view",
    "Publisher handoff",
  ]) {
    await expect(page.getByRole("heading", { name: feature })).toBeVisible();
  }
});
