import { expect, test } from "@playwright/test";

/**
 * Regression test: "Generate logline" button calls the API, populates the
 * textarea with the returned text, and leaves the input controlled so the
 * author can keep editing.
 *
 * Guards against:
 *  - The button not wiring up its onClick to generate.mutate()
 *  - onSuccess not calling setLogline, leaving the textarea empty
 *  - The textarea becoming uncontrolled after a generated value is set
 */
test("generate logline populates the textarea and stays editable", async ({ page }) => {
  const GENERATED = "A reluctant cartographer must map a city that rearranges itself each night.";

  // Intercept the logline generation API so the test is hermetic.
  await page.route("**/api/v1/compose/logline", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ logline: GENERATED }),
    });
  });

  // Create a fresh account so the test is self-contained.
  const email = `gen-logline-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/compose");
  await expect(page).toHaveURL(/\/compose$/);

  // ── Step 1: title ──────────────────────────────────────────────────────────
  const step1 = page.locator("#step-title");
  await expect(step1).toBeInViewport();
  await page.locator("#compose-title").fill("The Cartographer's Dilemma");
  await step1.getByRole("button", { name: "Continue" }).click();

  // ── Step 2: genre (skip) ───────────────────────────────────────────────────
  const step2 = page.locator("#step-genre");
  await expect(step2).toBeInViewport();
  await step2.getByRole("button", { name: "Continue" }).click();

  // ── Step 3: type (Fiction pre-selected, advance) ──────────────────────────
  const step3 = page.locator("#step-type");
  await expect(step3).toBeInViewport();
  await step3.getByRole("button", { name: "Continue" }).click();

  // ── Step 4: logline ────────────────────────────────────────────────────────
  const step4 = page.locator("#step-logline");
  await expect(step4).toBeInViewport();

  const loglineInput = page.locator("#compose-logline");
  await expect(loglineInput).toBeVisible();

  // Textarea is empty before generation.
  await expect(loglineInput).toHaveValue("");

  // Button is present and enabled before generation starts.
  const generateBtn = step4.getByRole("button", { name: /generate logline/i });
  await expect(generateBtn).toBeVisible();
  await expect(generateBtn).toBeEnabled();

  // Click generate — button should show "Generating…" while the request is in flight,
  // then revert to "Generate logline" once the mutation completes.
  await generateBtn.click();

  // After the (mocked) API responds, the textarea must contain the generated text.
  await expect(loglineInput).toHaveValue(GENERATED);

  // Button re-enables after generation finishes.
  await expect(generateBtn).toBeEnabled();

  // The textarea is still a controlled input: further edits should work normally.
  const EXTRA = " (revised)";
  await loglineInput.press("End");
  await loglineInput.type(EXTRA);
  await expect(loglineInput).toHaveValue(GENERATED + EXTRA);

  // Continue button becomes enabled because the logline is long enough (> 8 chars).
  const continueBtn = step4.getByRole("button", { name: "Continue" });
  await expect(continueBtn).toBeEnabled();
});
