import { expect, test } from "@playwright/test";

/**
 * Regression test: logline input accepts text and Continue advances the compose
 * flow forward (to the audience step), never backwards.
 *
 * Guards against the bug where pressing Continue or Enter on the logline step
 * scrolled the wizard to an earlier step instead of the next one.
 */
test("logline input accepts text and Continue advances forward without going backwards", async ({
  page,
}) => {
  // Create a fresh account so the test is self-contained.
  const email = `logline-regression-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Navigate directly to the compose flow.
  await page.goto("/compose");
  await expect(page).toHaveURL(/\/compose$/);

  // ── Step 1: title ──────────────────────────────────────────────────────────
  const step1 = page.locator("#step-title");
  await expect(step1).toBeInViewport();
  await page.locator("#compose-title").fill("Regression Test Book");
  await step1.getByRole("button", { name: "Continue" }).click();

  // ── Step 2: genre (optional, advance without selecting) ───────────────────
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

  // Step indicator shows the correct position in the flow.
  await expect(step4.getByText("Step 4 of 7")).toBeVisible();

  // Textarea is present and accepts keyboard input.
  const loglineInput = page.locator("#compose-logline");
  await expect(loglineInput).toBeVisible();

  const loglineText =
    "A stubborn inventor must outwit her own creation before it rewrites history without her.";
  await loglineInput.fill(loglineText);
  await expect(loglineInput).toHaveValue(loglineText);

  // Enter key inside the textarea must NOT trigger navigation — the wizard
  // intentionally suppresses Enter in textareas so authors can add newlines.
  await loglineInput.press("Enter");
  // Step 4 should still be in view (no scroll happened).
  await expect(step4).toBeInViewport();
  // Input value is unaffected.
  await expect(loglineInput).toHaveValue(loglineText + "\n");

  // Clear the newline before continuing.
  await loglineInput.fill(loglineText);
  await expect(loglineInput).toHaveValue(loglineText);

  // Continue button is enabled once ≥ 8 non-whitespace characters are present.
  const continueBtn = step4.getByRole("button", { name: "Continue" });
  await expect(continueBtn).toBeEnabled();

  // Clicking Continue scrolls FORWARD to step 5 (audience).
  await continueBtn.click();

  // ── Post-navigation assertions ─────────────────────────────────────────────
  // Step 5 must be in view.
  const step5 = page.locator("#step-audience");
  await expect(step5).toBeInViewport();

  // Step 5 indicator is correct.
  await expect(step5.getByText("Step 5 of 7")).toBeVisible();

  // Step 4 must have scrolled out of view (forward navigation confirmed).
  await expect(step4).not.toBeInViewport();

  // Steps 1–3 must also be out of view — guards against scroll wrapping
  // backwards to an earlier step.
  await expect(step1).not.toBeInViewport();
  await expect(step3).not.toBeInViewport();

  // URL stays on the compose route — no accidental hard navigation.
  await expect(page).toHaveURL(/\/compose$/);

  // The logline value is preserved after advancing (state not reset).
  await expect(loglineInput).toHaveValue(loglineText);
});
