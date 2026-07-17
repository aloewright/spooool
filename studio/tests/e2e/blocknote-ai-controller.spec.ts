import { type Locator, type Page, expect, test } from "@playwright/test";

const initialDraft = "Alpha before selected start.\n\nSelected end after omega.";

test.describe("BlockNote AI controller", () => {
  test("retains default controls and restores an exact cross-block selection", async ({ page }) => {
    const fixture = await createBlogFixture(page);
    const aiRequests: Array<Record<string, unknown>> = [];

    await page.route("**/api/v1/editor/ai", async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      aiRequests.push(request);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: {
            id: `revision-${aiRequests.length}`,
            before_md: request.target_md,
            after_md:
              request.scope === "selection"
                ? "First replacement.\n\nSecond replacement."
                : initialDraft,
            llm_response: { route: "dynamic/text_gen", tokens_in: 5, tokens_out: 3 },
          },
        }),
      });
    });

    await page.goto(fixture.editorPath);
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Alpha before selected start.");
    await expect(editor).toContainText("Selected end after omega.");

    await openSlashMenu(page, editor);
    const slashMenu = page.getByRole("listbox");
    await expect(slashMenu.getByRole("option", { name: /^Write\b/ })).toBeVisible();
    await expect(slashMenu.getByRole("option", { name: /^Heading 1\b/ })).toBeVisible();
    await expect(slashMenu.getByRole("option", { name: /^Paragraph\b/ })).toBeVisible();
    await slashMenu.getByRole("option", { name: /^Proofread\b/ }).click();
    await page
      .getByRole("dialog", { name: "Ready to review" })
      .getByRole("button", { name: "Reject", exact: true })
      .click();

    // Let the slash-trigger transaction settle before measuring the Apply save.
    await page.waitForTimeout(1_100);
    const appliedDrafts: string[] = [];
    await page.route(`**${fixture.patchPath}`, async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { draft_md?: string };
        if (body.draft_md?.includes("First replacement.")) appliedDrafts.push(body.draft_md);
      }
      await route.continue();
    });

    await selectRange(editor, "selected start.", "Selected end");
    await expect(page.getByRole("button", { name: "Bold" })).toBeVisible();
    const aiCommands = page.getByRole("button", { name: "AI commands" });
    await expect(aiCommands).toBeVisible();
    await aiCommands.click();
    await page
      .getByRole("dialog", { name: "AI commands" })
      .getByRole("button", { name: "Proofread", exact: true })
      .click();

    const review = page.getByRole("dialog", { name: "Ready to review" });
    await expect(review).toContainText("First replacement.");
    const selectionRequest = aiRequests.at(-1);
    expect(selectionRequest).toMatchObject({ command: "proofread", scope: "selection" });
    expect(String(selectionRequest?.target_md)).toContain("selected start.");
    expect(String(selectionRequest?.target_md)).toContain("Selected end");
    expect(String(selectionRequest?.target_md)).not.toContain("Alpha before");
    expect(String(selectionRequest?.target_md)).not.toContain("after omega");

    await review.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => appliedDrafts.length).toBe(1);
    expect(appliedDrafts[0]).toContain("Alpha before First replacement.");
    expect(appliedDrafts[0]).toContain("Second replacement. after omega.");
    expect(appliedDrafts[0]).not.toContain("selected start.");
    expect(appliedDrafts[0]).not.toContain("Selected end");
    await expect(editor).toContainText("Alpha before First replacement.");
    await expect(editor).toContainText("Second replacement. after omega.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("retries a failed command without mutating or saving when rejected", async ({ page }) => {
    const fixture = await createBlogFixture(page);
    let aiCalls = 0;
    let draftSaves = 0;

    await page.route("**/api/v1/editor/ai", async (route) => {
      aiCalls += 1;
      if (aiCalls === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "gateway unavailable" }),
        });
        return;
      }
      const request = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successfulRevision(request, "Retry replacement."),
      });
    });
    await page.route(`**${fixture.patchPath}`, async (route) => {
      if (route.request().method() === "PATCH") draftSaves += 1;
      await route.continue();
    });

    await page.goto(fixture.editorPath);
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Alpha before selected start.");
    await selectRange(editor, "selected start.", "selected start.");
    await page.getByRole("button", { name: "AI commands" }).click();
    await page
      .getByRole("dialog", { name: "AI commands" })
      .getByRole("button", { name: "Proofread", exact: true })
      .click();

    const errorDialog = page.getByRole("dialog", { name: "AI command failed" });
    await expect(errorDialog).toContainText("gateway unavailable");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toContainText("selected start.");
    expect(draftSaves).toBe(0);

    await errorDialog.getByRole("button", { name: "Retry", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Ready to review" });
    await expect(review).toContainText("Retry replacement.");
    expect(aiCalls).toBe(2);
    await review.getByRole("button", { name: "Reject", exact: true }).click();

    await expect(editor).toContainText("selected start.");
    await expect(editor).not.toContainText("Retry replacement.");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    expect(draftSaves).toBe(0);
  });

  test("retries only persistence when Apply succeeds but saveNow fails", async ({ page }) => {
    const fixture = await createBlogFixture(page);
    let aiCalls = 0;
    const saveBodies: Array<Record<string, unknown>> = [];

    await page.route("**/api/v1/editor/ai", async (route) => {
      aiCalls += 1;
      const request = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successfulRevision(request, "Persisted replacement."),
      });
    });
    await page.route(`**${fixture.patchPath}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      saveBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (saveBodies.length === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary save failure" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(fixture.editorPath);
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Alpha before selected start.");
    await selectRange(editor, "selected start.", "selected start.");
    await page.getByRole("button", { name: "AI commands" }).click();
    await page
      .getByRole("dialog", { name: "AI commands" })
      .getByRole("button", { name: "Proofread", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Ready to review" })
      .getByRole("button", { name: "Apply", exact: true })
      .click();

    const saveError = page.getByRole("dialog", { name: "Replacement not saved" });
    await expect(saveError).toContainText("temporary save failure");
    await expect(editor).toContainText("Persisted replacement.");
    expect(aiCalls).toBe(1);
    expect(saveBodies).toHaveLength(1);

    await saveError.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(saveError).toBeHidden();
    await expect.poll(() => saveBodies.length).toBe(2);
    expect(aiCalls).toBe(1);
    expect(String(saveBodies[0]?.draft_md)).toContain("Persisted replacement.");
    expect(String(saveBodies[1]?.draft_md)).toContain("Persisted replacement.");
    expect((await editor.innerText()).split("Persisted replacement.")).toHaveLength(2);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("aborts on unmount and ignores a response arriving after a new editor mounts", async ({
    page,
  }) => {
    const fixture = await createBlogFixture(page);
    let releaseResponse!: () => void;
    let markRequestStarted!: () => void;
    let routeSettled = false;
    let draftSaves = 0;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    await page.route("**/api/v1/editor/ai", async (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      markRequestStarted();
      await responseGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: successfulRevision(request, "Late replacement."),
        });
      } catch {
        // An aborted browser request can reject fulfillment. Either outcome
        // must be harmless to the newly mounted editor instance.
      } finally {
        routeSettled = true;
      }
    });
    await page.route(`**${fixture.patchPath}`, async (route) => {
      if (route.request().method() === "PATCH") draftSaves += 1;
      await route.continue();
    });

    await page.goto(fixture.editorPath);
    let editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Alpha before selected start.");
    await selectRange(editor, "selected start.", "selected start.");
    await page.getByRole("button", { name: "AI commands" }).click();
    await page
      .getByRole("dialog", { name: "AI commands" })
      .getByRole("button", { name: "Proofread", exact: true })
      .click();
    await requestStarted;
    await expect(page.getByRole("dialog", { name: "Working" })).toBeVisible();

    await page.goto("/");
    await page.goto(fixture.editorPath);
    editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Alpha before selected start.");
    releaseResponse();
    await expect.poll(() => routeSettled).toBe(true);

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editor).toContainText("selected start.");
    await expect(editor).not.toContainText("Late replacement.");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    expect(draftSaves).toBe(0);
  });
});

function successfulRevision(request: Record<string, unknown>, afterMd: string): string {
  return JSON.stringify({
    revision: {
      id: "revision-test",
      before_md: request.target_md,
      after_md: afterMd,
      llm_response: { route: "dynamic/text_gen", tokens_in: 5, tokens_out: 3 },
    },
  });
}

async function createBlogFixture(page: Page): Promise<{
  editorPath: string;
  patchPath: string;
}> {
  await page.goto("/sign-up");
  const signedUp = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      email: `controller-${Date.now()}-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "Editor Controller Test",
    },
  });
  expect(signedUp.ok()).toBe(true);

  const created = await page.request.post("/api/v1/blogs", {
    data: {
      title: "Controller Notes",
      format: "how-to",
      description: "Focused editor-controller regression coverage.",
      audience: ["Practitioners"],
      voice_links: [],
      voice_uploads: [{ name: "sample.md", text: "Use short, direct sentences." }],
      voice_profile_md: "Direct and practical.",
      rules_do: ["Use concrete examples"],
      rules_dont: ["Avoid filler"],
    },
  });
  expect(created.status()).toBe(201);
  const { id: blogId } = (await created.json()) as { id: string };

  const planned = await page.request.post(`/api/v1/blogs/${blogId}/plan`, {
    data: { structure: "single-tutorial", planned_posts: 1 },
  });
  expect(planned.ok()).toBe(true);
  const posts = await page.request.get(`/api/v1/blogs/${blogId}/posts`);
  expect(posts.ok()).toBe(true);
  const { items } = (await posts.json()) as { items: Array<{ id: string }> };
  const postId = items[0]?.id;
  expect(postId).toBeTruthy();

  const patchPath = `/api/v1/blogs/${blogId}/posts/${postId}`;
  const seeded = await page.request.patch(patchPath, {
    data: { draft_md: initialDraft, draft_version: 1 },
  });
  expect(seeded.ok()).toBe(true);

  return {
    editorPath: `/blogs/${blogId}/posts/${postId}`,
    patchPath,
  };
}

async function openSlashMenu(page: Page, editor: Locator) {
  await editor.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox")).toBeVisible();
}

async function selectRange(editor: Locator, startText: string, endText: string) {
  await editor.evaluate(
    (node, rangeText) => {
      const root = node as HTMLElement;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let startNode: Text | undefined;
      let endNode: Text | undefined;
      while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if (!startNode && textNode.data.includes(rangeText.startText)) startNode = textNode;
        if (textNode.data.includes(rangeText.endText)) endNode = textNode;
      }
      if (!startNode || !endNode) throw new Error("Could not find cross-block range endpoints");

      const start = startNode.data.indexOf(rangeText.startText);
      const end = endNode.data.indexOf(rangeText.endText) + rangeText.endText.length;
      const range = document.createRange();
      range.setStart(startNode, start);
      range.setEnd(endNode, end);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { endText, startText },
  );
}
