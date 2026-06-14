import { expect, test } from "@playwright/test";

/**
 * Regression guard: after clicking "Generate outline" and the API returns a
 * successful outline, the user must land on (or remain on) the outline route
 * and see the generated chapter content.
 *
 * Mocking strategy:
 *   - GET /api/v1/projects/:id/outline  — passes through to the server while
 *     no outline has been generated; switches to a canned mock response once
 *     the POST completes.
 *   - POST /api/v1/projects/:id/outlines — always intercepted, returns a
 *     successful mock payload without hitting the AI back-end.
 *
 * After the POST resolves we reload the page so React Query fetches fresh data
 * through the now-active GET mock, giving us a deterministic assertion point
 * without relying on React Query's window-focus refetch timing.
 */
test("generate outline button calls API and outline route displays resulting chapters", async ({
  page,
}) => {
  // ── 1. Create a fresh test account ────────────────────────────────────────
  const email = `outline-nav-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  // ── 2. Create a new project ───────────────────────────────────────────────
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByPlaceholder(/Working title/).fill("The Forgotten Archive");
  await page.getByRole("button", { name: /new book/i }).click();

  await page.getByRole("link", { name: /the forgotten archive/i }).click();
  // The studio route redirects to /canvas by default.
  await expect(page).toHaveURL(/\/[^/]+\/canvas$/);

  // ── 3. Wire up network mocks ──────────────────────────────────────────────
  let chaptersReady = false;

  const mockChapters = [
    {
      id: "ch-1",
      project_id: "mock-proj",
      ordinal: 1,
      title: "The First Discovery",
      summary: "The protagonist enters the archive and finds the first fragment.",
      status: "draft",
      target_words: 3000,
      draft_md: null,
      draft_json: null,
    },
    {
      id: "ch-2",
      project_id: "mock-proj",
      ordinal: 2,
      title: "The Hidden Passage",
      summary: "A secret corridor leads deeper into the forgotten stacks.",
      status: "draft",
      target_words: 3000,
      draft_md: null,
      draft_json: null,
    },
  ];

  // GET /outline — pass through until generation succeeds, then serve mock.
  await page.route("**/api/v1/projects/*/outline", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (chaptersReady) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ outline: { id: "mock-outline-1" }, chapters: mockChapters }),
      });
    } else {
      await route.continue();
    }
  });

  // POST /outlines — always intercepted; flips chaptersReady on success.
  await page.route("**/api/v1/projects/*/outlines", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    chaptersReady = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "mock-outline-1", outline: {}, chapters_created: 2 }),
    });
  });

  // ── 4. Navigate to the outline route via the canvas link ──────────────────
  // The canvas shows "Generate outline" when no chapters exist.  Clicking it
  // is the navigation step the test is guarding.
  await page.getByRole("link", { name: /generate outline/i }).click();
  await expect(page).toHaveURL(/\/[^/]+\/outline$/);

  // The outline wizard appears because the server returns no chapters yet.
  await expect(page.getByText(/pick a framework/i)).toBeVisible();

  // ── 5. Fill in the minimum required wizard field ──────────────────────────
  // The "Generate outline" CTA is disabled until questionnaire > 8 chars.
  await page
    .getByPlaceholder(/The protagonist discovers/i)
    .fill(
      "A librarian discovers a hidden archive beneath the city and must choose whether to preserve or destroy its forbidden contents.",
    );

  // ── 6. Trigger generation ─────────────────────────────────────────────────
  // The button lives in the scroll-snap review step (step 5); scroll it into
  // view before clicking so Playwright can interact with it.
  const generateBtn = page.getByRole("button", { name: /generate outline/i });
  await generateBtn.scrollIntoViewIfNeeded();
  await generateBtn.click();

  // Wait for the mocked POST to resolve — chaptersReady is now true.
  await page.waitForResponse(
    (resp) =>
      resp.url().includes("/outlines") &&
      resp.request().method() === "POST" &&
      resp.status() === 200,
  );

  // ── 7. Reload so React Query re-fetches outline data via the active mock ──
  await page.reload();

  // ── 8. Assertions ─────────────────────────────────────────────────────────
  // The URL must remain on the outline route (regression: broken redirect or
  // error page after generation).
  await expect(page).toHaveURL(/\/[^/]+\/outline$/);

  // Generated chapters must be rendered.
  await expect(page.getByText("The First Discovery")).toBeVisible();
  await expect(page.getByText("The Hidden Passage")).toBeVisible();

  // Chapter count badge in the sticky toolbar.
  await expect(page.getByText(/2 chapters/)).toBeVisible();
});
