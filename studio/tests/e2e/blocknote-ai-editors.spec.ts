import { type Locator, type Page, expect, test } from "@playwright/test";

const initialDraft = "Opening line. Replace this phrase only. Closing line.";
const selectedDraft = "Replace this phrase only.";
const replacementDraft = "Sharper selected prose.";

type EditorFixture = {
  editorPath: string;
  patchPath: string;
  resourceKind: "blog-post" | "script-scene";
};

const editorSetups = [
  { label: "blog post", setup: createBlogPost },
  { label: "script scene", setup: createScriptScene },
] as const;

for (const editorSetup of editorSetups) {
  test(`${editorSetup.label} exposes review-before-apply AI commands`, async ({ page }) => {
    await signUp(page, editorSetup.label);
    const fixture = await editorSetup.setup(page);
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
            after_md: request.scope === "selection" ? replacementDraft : "# Revised document",
            llm_response: { route: "dynamic/text_gen", tokens_in: 5, tokens_out: 3 },
          },
        }),
      });
    });

    await page.goto(fixture.editorPath);
    const editor = page.locator('[contenteditable="true"]');
    await expect(editor).toContainText(initialDraft);

    await openSlashMenu(page, editor);
    for (const command of ["Write", "Proofread", "Cite", "Rewrite"]) {
      await expect(page.getByText(command, { exact: true })).toBeVisible();
    }

    await page.getByText("Proofread", { exact: true }).click();
    const documentReview = page.getByRole("dialog", { name: "Ready to review" });
    await expect(documentReview).toBeVisible();
    expect(aiRequests.at(-1)).toMatchObject({
      resource_kind: fixture.resourceKind,
      scope: "document",
      command: "proofread",
    });

    await page.evaluate(() => {
      const root = document.documentElement;
      root.classList.add("dark");
      if (root.dataset.theme?.endsWith("-light")) {
        root.dataset.theme = root.dataset.theme.replace(/-light$/, "-dark");
      }
    });
    await expectReadableDarkDialog(documentReview);
    await documentReview.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(documentReview).toBeHidden();
    await expect(editor).toContainText(initialDraft);
    await expect(editor).not.toContainText("Revised document");

    await openSlashMenu(page, editor);
    await page.getByText("Rewrite", { exact: true }).click();
    const instructionDialog = page.getByRole("dialog", { name: "Rewrite with AI" });
    await expect(instructionDialog).toBeVisible();
    await expect(instructionDialog.getByLabel("Instructions")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(instructionDialog).toBeHidden();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toContainText(initialDraft);

    await selectText(editor, selectedDraft);
    const aiCommands = page.getByRole("button", { name: "AI commands" });
    await expect(aiCommands).toBeVisible();
    await aiCommands.click();

    const chooser = page.getByRole("dialog", { name: "AI commands" });
    await chooser.getByRole("button", { name: "Rewrite", exact: true }).click();
    const selectionInstructions = page.getByRole("dialog", { name: "Rewrite with AI" });
    await selectionInstructions.getByLabel("Instructions").fill("Make the selection sharper.");
    await selectionInstructions.getByRole("button", { name: "Generate", exact: true }).click();

    const selectionReview = page.getByRole("dialog", { name: "Ready to review" });
    await expect(selectionReview).toBeVisible();
    const selectionRequest = aiRequests.at(-1);
    expect(selectionRequest).toMatchObject({
      resource_kind: fixture.resourceKind,
      scope: "selection",
      command: "rewrite",
      instructions: "Make the selection sharper.",
    });
    expect(String(selectionRequest?.target_md).trim()).toBe(selectedDraft);

    const acceptedPatch = page.waitForRequest((request) => {
      if (request.method() !== "PATCH" || new URL(request.url()).pathname !== fixture.patchPath) {
        return false;
      }
      const body = request.postDataJSON() as { draft_md?: string } | null;
      return body?.draft_md?.includes(replacementDraft) ?? false;
    });
    await selectionReview.getByRole("button", { name: "Apply", exact: true }).click();

    const patchRequest = await acceptedPatch;
    const patchBody = patchRequest.postDataJSON() as { draft_md: string };
    expect(patchBody.draft_md).toContain("Opening line.");
    expect(patchBody.draft_md).toContain(replacementDraft);
    expect(patchBody.draft_md).toContain("Closing line.");
    expect(patchBody.draft_md).not.toContain(selectedDraft);
    expect((await patchRequest.response())?.ok()).toBe(true);
    await expect(editor).toContainText(`Opening line. ${replacementDraft} Closing line.`);
    await expect(editor).not.toContainText(selectedDraft);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });
}

async function signUp(page: Page, label: string) {
  await page.goto("/sign-up");
  const response = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      email: `${label.replaceAll(" ", "-")}-${Date.now()}-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "Editor AI Test",
    },
  });
  expect(response.ok()).toBe(true);
}

async function createBlogPost(page: Page): Promise<EditorFixture> {
  const created = await page.request.post("/api/v1/blogs", {
    data: {
      title: "Field Notes",
      format: "how-to",
      description: "Practical field notes for shipping reliable systems.",
      audience: ["Practitioners"],
      voice_links: [],
      voice_uploads: [{ name: "sample.md", text: "Use short, direct, practical sentences." }],
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
  const seeded = await page.request.patch(patchPath, { data: { draft_md: initialDraft } });
  expect(seeded.ok()).toBe(true);

  return {
    editorPath: `/blogs/${blogId}/posts/${postId}`,
    patchPath,
    resourceKind: "blog-post",
  };
}

async function createScriptScene(page: Page): Promise<EditorFixture> {
  const created = await page.request.post("/api/v1/scripts", {
    data: {
      title: "Final Approach",
      format: "short-film",
      logline: "A controller guides an estranged pilot through a dangerous storm.",
      genre: "Drama",
    },
  });
  expect(created.status()).toBe(201);
  const { id: scriptId } = (await created.json()) as { id: string };

  const planned = await page.request.post(`/api/v1/scripts/${scriptId}/plan`, {
    data: { structure: "mini-arc", planned_scenes: 3 },
  });
  expect(planned.ok()).toBe(true);

  const scenes = await page.request.get(`/api/v1/scripts/${scriptId}/scenes`);
  expect(scenes.ok()).toBe(true);
  const { items } = (await scenes.json()) as { items: Array<{ id: string }> };
  const sceneId = items[0]?.id;
  expect(sceneId).toBeTruthy();

  const patchPath = `/api/v1/scripts/${scriptId}/scenes/${sceneId}`;
  const seeded = await page.request.patch(patchPath, { data: { draft_md: initialDraft } });
  expect(seeded.ok()).toBe(true);

  return {
    editorPath: `/scripts/${scriptId}/scenes/${sceneId}`,
    patchPath,
    resourceKind: "script-scene",
  };
}

async function openSlashMenu(page: Page, editor: Locator) {
  await editor.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByText("Write", { exact: true })).toBeVisible();
}

async function selectText(editor: Locator, target: string) {
  await editor.evaluate((node, selectedText) => {
    const root = node as HTMLElement;
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Array<{ end: number; node: Text; start: number }> = [];
    let fullText = "";
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const start = fullText.length;
      fullText += textNode.data;
      textNodes.push({ end: fullText.length, node: textNode, start });
    }

    const selectionStart = fullText.indexOf(selectedText);
    if (selectionStart < 0) throw new Error(`Could not find selected text: ${selectedText}`);
    const selectionEnd = selectionStart + selectedText.length;
    const startNode = textNodes.find(
      (entry) => selectionStart >= entry.start && selectionStart < entry.end,
    );
    const endNode = textNodes.find(
      (entry) => selectionEnd > entry.start && selectionEnd <= entry.end,
    );
    if (!startNode || !endNode) throw new Error("Could not map selected text to editor nodes");

    const range = document.createRange();
    range.setStart(startNode.node, selectionStart - startNode.start);
    range.setEnd(endNode.node, selectionEnd - endNode.start);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, target);
}

async function expectReadableDarkDialog(dialog: Locator) {
  await expect
    .poll(() =>
      dialog.evaluate((node) => {
        const text = node.querySelector("pre") ?? node;
        let surface: Element | null = text;
        let background = [0, 0, 0, 0];
        while (surface) {
          background = parseColor(getComputedStyle(surface).backgroundColor);
          if (background[3] >= 230) break;
          surface = surface.parentElement;
        }
        const foreground = parseColor(getComputedStyle(text).color);
        return contrast(foreground, background);

        function parseColor(value: string): number[] {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) return [0, 0, 0, 0];
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        }

        function contrast(foreground: number[], backgroundColor: number[]): number {
          const luminance = (color: number[]) => {
            const linear = color.slice(0, 3).map((channel) => {
              const value = channel / 255;
              return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
          };
          const lighter = Math.max(luminance(foreground), luminance(backgroundColor));
          const darker = Math.min(luminance(foreground), luminance(backgroundColor));
          return (lighter + 0.05) / (darker + 0.05);
        }
      }),
    )
    .toBeGreaterThanOrEqual(4.5);
}
