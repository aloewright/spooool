import { expect, test } from "@playwright/test";

test("fiction projects can generate a genre-specific outline", async ({ page }) => {
  const dynamicImportErrors: string[] = [];
  const dynamicImportErrorPattern =
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
  page.on("pageerror", (error) => {
    if (dynamicImportErrorPattern.test(error.message)) dynamicImportErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (dynamicImportErrorPattern.test(text)) dynamicImportErrors.push(text);
  });

  const email = `outline-style-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByPlaceholder(/Working title/).fill("Signal Garden");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Fiction", exact: true }).click();
  await page.getByRole("button", { name: /new book/i }).click();

  await page.getByRole("link", { name: /signal garden/i }).click();
  await page.getByLabel("Go to Outline workflow").click();
  await expect(page.getByRole("heading", { name: /outline builder/i })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Project workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to Outline Setup" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Outline workspace sections" })).toBeVisible();
  await expect(page.getByTestId("book-flow-preview")).toBeVisible();
  const frameworkQuestion = page.getByText("Who is the protagonist and what do they want?");
  await expect(frameworkQuestion).toBeVisible();
  const frameworkQuestionBox = await frameworkQuestion.boundingBox();
  expect(frameworkQuestionBox).not.toBeNull();
  expect(frameworkQuestionBox?.width).toBeGreaterThan(240);
  expect(frameworkQuestionBox?.height).toBeLessThan(80);
  await page.getByRole("combobox", { name: /outline framework/i }).click();
  await page.getByRole("option", { name: /Sci-Fi World/i }).click();
  await expect(page.getByText(/Speculative premise, world rules/i)).toBeVisible();

  await page
    .getByPlaceholder(/Protagonist, want, weakness/i)
    .fill("A botanist discovers plants that store memories from future colonists.");
  await page.getByRole("tab", { name: /Chapter board/i }).click();
  await expect(page.getByRole("heading", { name: /chapter decision board/i })).toBeVisible();
  await page.getByLabel("Chapter 1 working title").fill("The Memory Orchard");
  await page
    .getByLabel("Chapter 1 what happens")
    .fill("Mara finds a greenhouse tree replaying a future evacuation.");
  await page.getByLabel("Chapter 1 purpose").fill("Prove the premise with a visible event.");
  await page.getByLabel("Chapter 1 POV").fill("Mara");
  await page.getByLabel("Chapter 1 characters").fill("Mara, Ivo");
  await page.getByRole("tab", { name: /Characters/i }).click();
  await page.getByLabel("Character 1 name").fill("Mara");
  await page.getByRole("combobox", { name: "Character 1 arc", exact: true }).click();
  await page.getByRole("option", { name: "Positive Change", exact: true }).click();
  await page
    .getByLabel("Character 1 arc position")
    .fill("Refusing the truth that memory can be communal.");
  await page
    .getByLabel("Character 1 scene role")
    .fill("Protagonist under scientific and family pressure.");
  await page.getByRole("button", { name: /add character/i }).click();
  await page.getByLabel("Character 2 name").fill("Ivo");
  await page.getByRole("combobox", { name: "Character 2 arc", exact: true }).click();
  await page.getByRole("option", { name: "Flat", exact: true }).click();
  await page.getByLabel("Character 2 arc position").fill("Already carries the story truth.");
  await page.getByPlaceholder(/Default scene cast/i).fill("Use Mara and Ivo in discovery scenes.");
  await page.getByRole("button", { name: /generate outline/i }).click();

  const plannedChapter = page.getByRole("link", { name: /1\. The Memory Orchard/ });
  await expect(plannedChapter).toBeVisible();
  await expect(plannedChapter).toContainText(/future evacuation/);
  await expect(page.getByText(/14 chapters/)).toBeVisible();
  const chapterLinkColor = await plannedChapter.evaluate(
    (node) => window.getComputedStyle(node).color,
  );
  await plannedChapter.click();
  await expect(page).toHaveURL(/\/chapters\//);
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await page.getByLabel("Go to Outline workflow").click();
  await page.getByRole("tab", { name: /Generated/i }).click();
  await expect(plannedChapter).toBeVisible();
  await expect
    .poll(() => plannedChapter.evaluate((node) => window.getComputedStyle(node).color))
    .toBe(chapterLinkColor);
  await page.getByRole("link", { name: "Full book" }).click();
  await expect(page).toHaveURL(/\/book$/);
  await expect(page.getByRole("heading", { name: "Full book" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: /outline builder/i })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("heading", { name: /outline builder/i })
        .evaluate((node) => Number.parseFloat(window.getComputedStyle(node).opacity)),
    )
    .toBe(1);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Full book" })).toBeVisible();
  expect(dynamicImportErrors).toEqual([]);
});

test("reduced-motion users see outline text and static book flow immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const email = `outline-reduced-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByPlaceholder(/Working title/).fill("Still Map");
  await page.getByRole("button", { name: /new book/i }).click();
  await page.getByRole("link", { name: /still map/i }).click();
  await page.getByLabel("Go to Outline workflow").click();

  await expect(page.getByRole("heading", { name: /outline builder/i })).toBeVisible();
  await expect(page.getByTestId("book-flow-static")).toBeVisible();
  await expect(page.getByText(/Pick a framework/i)).toBeVisible();
});
