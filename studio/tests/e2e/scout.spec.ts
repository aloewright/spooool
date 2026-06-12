import { expect, test } from "@playwright/test";

test("scout page runs a niche query and shows evidence", async ({ page }) => {
  const email = `scout-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("link", { name: "Scout" }).click();
  await expect(page).toHaveURL(/\/scout$/);
  await page.getByPlaceholder("Niche or reader demand").fill("cozy fantasy mysteries");
  await page.getByLabel("Target reader").fill("cozy readers who want gentle magic");
  await page.getByLabel("Scout angle").fill("a magical bookshop mystery with found-family warmth");
  await page.getByRole("button", { name: /run scout/i }).click();

  await expect(
    page.getByRole("heading", { name: "cozy fantasy mysteries", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("heading", { name: "Gap analysis" }),
  ).toBeVisible();
  await expect(page.getByText("Opportunity", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scout verdict" })).toBeVisible();
  await expect(
    page
      .locator("p")
      .filter({ hasText: /magical bookshop mystery/i })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Positioning brief")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Source mix" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keyword clusters" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();

  await page.getByRole("button", { name: "Action items" }).click();
  await expect(page.getByText("Validation steps")).toBeVisible();
  await expect(page.getByText("Questions before outline")).toBeVisible();
});

test("project concept can pull findings from Scout", async ({ page }) => {
  const email = `project-scout-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByPlaceholder("Working title…").fill("Neurofounder Systems");
  await page.getByRole("button", { name: /new book/i }).click();
  await page.getByRole("link", { name: /neurofounder systems/i }).click();

  await expect(page.getByRole("heading", { name: "Concept", exact: true })).toBeVisible();
  await page.getByLabel("Scout target reader").fill("neurodivergent solo founders");
  await page.getByLabel("Scout angle").fill("a calmer weekly operating system");
  await page.getByRole("button", { name: /pull from scout/i }).click();

  await expect(page.getByText("Scout pulled")).toBeVisible();
  await expect(page.getByText(/evidence rows/i)).toBeVisible();
  await expect(page.getByText("Scout brief")).toBeVisible();
  await expect(
    page
      .locator("p")
      .filter({ hasText: /calmer weekly operating system/i })
      .first(),
  ).toBeVisible();
});
