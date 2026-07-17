import { expect, test } from "@playwright/test";

test("sign-up -> outline -> chapter editor autosave", async ({ page }) => {
  test.setTimeout(90_000);
  const editorAiRequests: Array<{
    command: string;
    scope: string;
    target_md: string;
    context_md: string;
    instructions?: string;
  }> = [];
  await page.route("**/api/v1/editor/ai", async (route) => {
    const request = route.request().postDataJSON() as (typeof editorAiRequests)[number];
    editorAiRequests.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revision: {
          id: "revision-test",
          before_md: request.target_md,
          after_md: request.scope === "selection" ? "Sharper selected prose." : "# Revised chapter",
          llm_response: { route: "dynamic/text_gen", tokens_in: 5, tokens_out: 3 },
        },
      }),
    });
  });

  const email = `chapter-${Date.now()}@x.test`;
  await page.goto("/sign-up");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: /new book/i }).click();
  await expect(page).toHaveURL(/\/compose$/);
  await page.getByPlaceholder("Untitled book").fill("Quiet Operator");
  await page.locator("#step-title").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-genre").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-type").getByRole("button", { name: "Nonfiction" }).click();
  await page.locator("#step-type").getByRole("button", { name: "Continue" }).click();
  await page
    .locator("#step-logline")
    .getByRole("textbox")
    .fill("A reactive operator discovers a calmer way to work under pressure.");
  await page.locator("#step-logline").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-audience").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-voice").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-review").getByRole("button", { name: "Open canvas" }).click();

  await page.getByRole("link", { name: "Outline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pick a framework" })).toBeVisible();
  await page.locator("#step-framework").getByRole("button", { name: "Continue" }).click();

  await page
    .locator("#step-premise")
    .getByRole("textbox")
    .fill("Readers are stuck in reactive work. Promise a calmer operating model.");
  await page.locator("#step-premise").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-characters").getByRole("button", { name: "Continue" }).click();
  await page.locator("#step-chapter-plan").getByRole("button", { name: "Continue" }).click();
  await page
    .locator("#step-review")
    .getByRole("button", { name: /generate outline/i })
    .click();
  await expect(page.getByRole("textbox", { name: "Chapter title" }).first()).toHaveValue(
    "The Cost of Staying Stuck",
  );

  await page.getByRole("link", { name: "Open chapter editor" }).first().click();
  await expect(page).toHaveURL(/\/chapters\//);
  await expect(page.getByRole("heading", { name: "The Cost of Staying Stuck" })).toBeVisible();
  const scenesView = page.getByRole("button", { name: "Scenes", exact: true });
  await expect(scenesView).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Scene summary" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlock structure" })).toBeVisible();

  const draftView = page.getByRole("button", { name: "Draft", exact: true });
  await draftView.click();
  await expect(draftView).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: /section drafts/i })).toBeVisible();

  await page
    .getByRole("button", { name: /draft section/i })
    .first()
    .click();
  await expect(page.getByTestId("section-diff").first()).toContainText("concrete moment", {
    timeout: 15_000,
  });
  await expect(page.getByLabel("Redraft instructions for section 1")).toBeVisible();
  await page
    .getByLabel("Redraft instructions for section 1")
    .fill("Make this more specific and keep the operating model language.");
  await page
    .getByRole("button", { name: /redraft/i })
    .first()
    .click();
  await expect(page.getByTestId("section-diff").first()).toContainText("Apply this redraft", {
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /accept into chapter/i })
    .first()
    .click();

  const editor = page.locator('[data-testid="chapter-editor"] [contenteditable="true"]').first();
  await expect(editor).toContainText("concrete moment", { timeout: 10_000 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const editorSurface = document.querySelector("[data-testid='chapter-editor'] .bn-editor");
        const editable = document.querySelector("[data-testid='chapter-editor'] [contenteditable]");
        if (!editorSurface || !editable) return false;
        const surfaceStyle = getComputedStyle(editorSurface);
        const editableStyle = getComputedStyle(editable);
        return (
          surfaceStyle.backgroundColor !== "rgb(255, 255, 255)" &&
          editableStyle.color !== "rgb(0, 0, 0)"
        );
      }),
    )
    .toBe(true);
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  const originalText = "Opening sentence. Selected sentence needs revision. Closing sentence.";
  await page.keyboard.type(originalText);

  await page.keyboard.type("/");
  const slashMenu = page.getByRole("listbox");
  await expect(slashMenu.getByText("AI", { exact: true })).toBeVisible();
  for (const command of ["Write", "Proofread", "Cite", "Rewrite"]) {
    await expect(
      slashMenu.getByRole("option", { name: new RegExp(`^${command}\\b`) }),
    ).toBeVisible();
  }
  await slashMenu.getByRole("option", { name: /^Proofread\b/ }).click();

  const documentReview = page.getByRole("dialog", { name: "Ready to review" });
  await expect(documentReview).toContainText("Revised chapter");
  await expect.poll(() => editorAiRequests.length).toBe(1);
  expect(editorAiRequests[0]).toMatchObject({
    command: "proofread",
    scope: "document",
  });
  expect(editorAiRequests[0]?.target_md).toContain(originalText);
  await documentReview.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(documentReview).toBeHidden();
  await expect(editor).toHaveText(originalText);
  await expect(editor).not.toContainText("Revised chapter");

  const selectedSentence = "Selected sentence needs revision.";
  await editor.evaluate((node, targetText) => {
    (node as HTMLElement).focus();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent?.includes(targetText)) {
      textNode = walker.nextNode();
    }
    if (!textNode?.textContent) throw new Error(`Could not select: ${targetText}`);

    const start = textNode.textContent.indexOf(targetText);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + targetText.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, selectedSentence);

  const aiCommands = page.getByRole("button", { name: "AI commands" });
  await expect(aiCommands).toBeVisible();
  await aiCommands.click();
  const commandChooser = page.getByRole("dialog", { name: "AI commands" });
  await commandChooser.getByRole("button", { name: "Rewrite", exact: true }).click();

  const instructions = "Make this selection more concise and vivid.";
  const rewriteDialog = page.getByRole("dialog", { name: "Rewrite with AI" });
  await rewriteDialog.getByRole("textbox", { name: "Instructions" }).fill(instructions);
  await rewriteDialog.getByRole("button", { name: "Generate", exact: true }).click();

  const selectionReview = page.getByRole("dialog", { name: "Ready to review" });
  await expect(selectionReview).toContainText("Sharper selected prose.");
  await expect.poll(() => editorAiRequests.length).toBe(2);
  expect(editorAiRequests[1]).toMatchObject({
    command: "rewrite",
    scope: "selection",
    instructions,
  });
  expect(editorAiRequests[1]?.target_md).toContain(selectedSentence);
  expect(editorAiRequests[1]?.context_md).toContain(originalText);
  await selectionReview.getByRole("button", { name: "Apply", exact: true }).click();

  const rewrittenText = "Opening sentence. Sharper selected prose. Closing sentence.";
  await expect(editor).toHaveText(rewrittenText);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  const tighten = page.getByRole("button", { name: /tighten/i });
  if (!(await tighten.isEnabled())) {
    await editor.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  }
  await expect(tighten).toBeEnabled();
  await tighten.click();
  await expect(page.getByTestId("inline-ai-diff")).toContainText("Tightened:", {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /apply replacement/i }).click();
  await expect(editor).toContainText("Tightened:", { timeout: 10_000 });

  await expect(page.getByText(/Saving|Saved/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/saved words/i)).toBeVisible();
  await scenesView.click();
  await expect(scenesView).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Scene summary" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlock structure" })).toBeVisible();
  await page.getByRole("link", { name: "Book", exact: true }).click();
  await expect(page).toHaveURL(/\/book$/);
  await expect(page.getByRole("heading", { name: "Full book" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Book menu" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Tightened:/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit" }).first()).toBeVisible();
});
