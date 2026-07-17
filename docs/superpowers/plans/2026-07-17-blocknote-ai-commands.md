# BlockNote AI Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add review-before-apply `Write`, `Proofread`, `Cite`, and `Rewrite` commands to Spooool's chapter, blog-post, and script-scene BlockNote editors.

**Architecture:** A shared request contract and Worker-side editor-command skill route all generations through Cloudflare AI Gateway. A reusable BlockNote client controller supplies a custom slash menu, selection toolbar, instruction/review dialogs, ProseMirror bookmark restoration, and host-provided immediate save callbacks. Existing editor autosave remains authoritative, and the older chapter inline-AI feature remains behaviorally separate.

**Tech Stack:** TypeScript, React 19, BlockNote 0.49, TanStack Query, Hono, Zod, Drizzle/D1, Cloudflare AI Gateway, Vitest with Cloudflare Workers pool, Playwright.

## Global Constraints

- Commands are exactly `write`, `proofread`, `cite`, and `rewrite`.
- Slash-menu invocation always targets the whole document; selection-toolbar invocation always targets the exact selected text.
- Every generation requires explicit Apply before the document changes or autosaves.
- `write`, `proofread`, and `rewrite` use `dynamic/text_gen`; `cite` uses `dynamic/research_gen`.
- All provider traffic uses the existing AI Gateway client and `cf-aig-zdr: true`; no provider SDK, direct provider call, new secret, or `@blocknote/xl-ai` dependency is allowed.
- The new editor-command skill has no deterministic prose fallback.
- The existing chapter inline-AI toolbar stays and retains its deterministic local-development fallback.
- A successful proposal is written to the existing `revisions` table; no D1 migration is required.
- The editor stays read-only from target capture until Apply, Reject, cancellation, or terminal error.
- Existing BlockNote default slash commands, formatting controls, dark mode, autosave race guards, and chapter inline-AI behavior must remain functional.

---

### Task 1: Shared command contract and Worker-side generation skill

**Files:**

- Create: `studio/apps/web/src/shared/editor-ai.ts`
- Create: `studio/apps/web/src/skills/editor-command.ts`
- Create: `studio/tests/unit/editor-command.test.ts`

**Interfaces:**

- Produces: `EDITOR_AI_COMMANDS`, `EditorAiCommand`, `EditorAiScope`, `EditorAiResourceKind`, `EditorAiRequest`, `EditorAiRevision`, and `editorAiRequestSchema` from `src/shared/editor-ai.ts`.
- Produces: `EditorResourceContext`, `buildEditorCommandMessages(input)`, and `runEditorCommand(env, input, options?)` from `src/skills/editor-command.ts`.
- `runEditorCommand` returns `{ markdown, llm_response: { route, tokens_in, tokens_out } }` and throws for missing gateway configuration, empty output, or oversized output.

- [ ] **Step 1: Write request-contract and prompt-routing tests**

Create `studio/tests/unit/editor-command.test.ts` with focused tests that establish the public behavior before implementation:

```ts
import { describe, expect, it, vi } from "vitest";
import { editorAiRequestSchema } from "../../apps/web/src/shared/editor-ai";
import {
  buildEditorCommandMessages,
  runEditorCommand,
} from "../../apps/web/src/skills/editor-command";

const chapterContext = {
  kind: "chapter" as const,
  projectTitle: "Quiet Operator",
  projectType: "nonfiction" as const,
  chapterTitle: "The Cost of Staying Stuck",
  chapterSummary: "Show why reactive work remains expensive.",
  voiceProfile: { cadence: "short and direct" },
};

describe("editor AI request contract", () => {
  it("requires rewrite instructions and non-write target content", () => {
    expect(() =>
      editorAiRequestSchema.parse({
        resource_kind: "chapter",
        resource_id: "chapter-1",
        command: "rewrite",
        scope: "selection",
        target_md: "Selected prose.",
        context_md: "Selected prose in context.",
      }),
    ).toThrow();

    expect(() =>
      editorAiRequestSchema.parse({
        resource_kind: "blog-post",
        resource_id: "post-1",
        command: "proofread",
        scope: "document",
        target_md: "",
        context_md: "",
      }),
    ).toThrow();
  });

  it("permits an empty whole-document write", () => {
    expect(
      editorAiRequestSchema.parse({
        resource_kind: "script-scene",
        resource_id: "scene-1",
        command: "write",
        scope: "document",
        target_md: "",
        context_md: "",
      }).command,
    ).toBe("write");
  });
});

describe("editor command prompts", () => {
  it("requests only replacement prose for a selection", () => {
    const messages = buildEditorCommandMessages({
      request: {
        resource_kind: "chapter",
        resource_id: "chapter-1",
        command: "proofread",
        scope: "selection",
        target_md: "This are selected.",
        context_md: "Before. This are selected. After.",
      },
      context: chapterContext,
    });
    expect(messages[1].content).toContain("Return only replacement Markdown for the selected passage");
    expect(messages[1].content).toContain("This are selected.");
    expect(messages[1].content).toContain("Quiet Operator");
  });

  it.each([
    ["write", "dynamic/text_gen"],
    ["proofread", "dynamic/text_gen"],
    ["rewrite", "dynamic/text_gen"],
    ["cite", "dynamic/research_gen"],
  ] as const)("routes %s through %s", async (command, route) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Replacement prose." } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );
    const request = {
      resource_kind: "chapter" as const,
      resource_id: "chapter-1",
      command,
      scope: "document" as const,
      target_md: command === "write" ? "" : "Draft prose.",
      context_md: "Draft prose.",
      instructions: command === "rewrite" ? "Make it clearer." : undefined,
    };
    const result = await runEditorCommand(
      { AI_GATEWAY_BASE_URL: "https://gateway.test", AI_GATEWAY_TOKEN: "token" },
      { request, context: chapterContext },
      { fetch: fetchMock },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe(route);
    expect(result.markdown).toBe("Replacement prose.");
    expect(result.llm_response.route).toBe(route);
  });

  it("rejects missing configuration and empty fenced output", async () => {
    await expect(
      runEditorCommand(
        { AI_GATEWAY_BASE_URL: "", AI_GATEWAY_TOKEN: "" },
        {
          request: {
            resource_kind: "chapter",
            resource_id: "chapter-1",
            command: "proofread",
            scope: "document",
            target_md: "Draft prose.",
            context_md: "Draft prose.",
          },
          context: chapterContext,
        },
      ),
    ).rejects.toThrow("AI Gateway is not configured");
  });
});
```

- [ ] **Step 2: Run the unit test and confirm the contract is missing**

Run:

```bash
cd studio
pnpm vitest run tests/unit/editor-command.test.ts
```

Expected: FAIL because `src/shared/editor-ai.ts` and `src/skills/editor-command.ts` do not exist.

- [ ] **Step 3: Implement the shared contract**

Create `studio/apps/web/src/shared/editor-ai.ts` with the exact command/resource types and validation caps:

```ts
import { z } from "zod";

export const EDITOR_AI_COMMANDS = ["write", "proofread", "cite", "rewrite"] as const;
export const EDITOR_AI_RESOURCE_KINDS = ["chapter", "blog-post", "script-scene"] as const;
export const EDITOR_AI_SCOPES = ["document", "selection"] as const;

export type EditorAiCommand = (typeof EDITOR_AI_COMMANDS)[number];
export type EditorAiResourceKind = (typeof EDITOR_AI_RESOURCE_KINDS)[number];
export type EditorAiScope = (typeof EDITOR_AI_SCOPES)[number];
export type EditorAiRoute = "dynamic/text_gen" | "dynamic/research_gen";

export const editorAiRequestSchema = z
  .object({
    resource_kind: z.enum(EDITOR_AI_RESOURCE_KINDS),
    resource_id: z.string().min(1).max(200),
    command: z.enum(EDITOR_AI_COMMANDS),
    scope: z.enum(EDITOR_AI_SCOPES),
    target_md: z.string().max(100_000),
    context_md: z.string().max(200_000),
    instructions: z.string().trim().min(1).max(4_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.command === "rewrite" && !value.instructions) {
      ctx.addIssue({ code: "custom", path: ["instructions"], message: "rewrite needs instructions" });
    }
    if (!(value.command === "write" && value.scope === "document") && !value.target_md.trim()) {
      ctx.addIssue({ code: "custom", path: ["target_md"], message: "target is empty" });
    }
  });

export type EditorAiRequest = z.infer<typeof editorAiRequestSchema>;

export type EditorAiRevision = {
  id: string;
  before_md: string;
  after_md: string;
  llm_response: {
    route: EditorAiRoute;
    tokens_in: number;
    tokens_out: number;
  };
};
```

- [ ] **Step 4: Implement content-type prompts and gateway routing**

Create `studio/apps/web/src/skills/editor-command.ts`. Define a discriminated `EditorResourceContext` union for chapter, blog-post, and script-scene metadata. Implement these exact rules:

```ts
const routeFor = (command: EditorAiCommand): EditorAiRoute =>
  command === "cite" ? "dynamic/research_gen" : "dynamic/text_gen";

const normalizeOutput = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const markdown = (fenced?.[1] ?? trimmed).trim();
  if (!markdown) throw new Error("AI returned no usable replacement");
  if (markdown.length > 200_000) throw new Error("AI replacement is too large");
  return markdown;
};

export async function runEditorCommand(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: EditorCommandInput,
  options: { fetch?: typeof fetch } = {},
): Promise<EditorCommandResult> {
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    throw new Error("AI Gateway is not configured");
  }
  const route = routeFor(input.request.command);
  const result = await gateway.chatCompletion(env, {
    route,
    temperature: input.request.command === "proofread" || route === "dynamic/research_gen" ? 0.2 : 0.5,
    maxTokens: input.request.scope === "selection" ? 1_500 : 4_000,
    messages: buildEditorCommandMessages(input),
    fetch: options.fetch,
  });
  return {
    markdown: normalizeOutput(result.text),
    llm_response: { route, tokens_in: result.tokens_in, tokens_out: result.tokens_out },
  };
}
```

`buildEditorCommandMessages` must emit one system and one user message, include authoritative resource metadata, delimit `target_md` and `context_md`, require replacement-only output for selection scope, require the complete body for document scope, and state the command-specific preservation requirements from the design spec.

- [ ] **Step 5: Run the focused and full unit suites**

Run:

```bash
cd studio
pnpm vitest run tests/unit/editor-command.test.ts tests/unit/gateway.test.ts
pnpm vitest run
```

Expected: the focused tests pass; the full unit suite remains at or above 21 passing files and 78 passing tests.

- [ ] **Step 6: Commit Task 1**

```bash
git add studio/apps/web/src/shared/editor-ai.ts studio/apps/web/src/skills/editor-command.ts studio/tests/unit/editor-command.test.ts
git commit -m "feat: add shared editor AI command skill"
```

---

### Task 2: Authenticated editor-AI route, context resolution, audit revisions, and budget guard

**Files:**

- Create: `studio/apps/web/src/routes/editor-ai.ts`
- Create: `studio/tests/integration/editor-ai.test.ts`
- Modify: `studio/apps/web/src/index.ts:10-124`
- Modify: `studio/apps/web/src/routes/chapters.ts:1-185`
- Modify: `studio/apps/web/vitest.config.ts:8-23`

**Interfaces:**

- Consumes: `editorAiRequestSchema`, `EditorAiRequest`, `EditorAiRevision`, `EditorResourceContext`, and `runEditorCommand` from Task 1.
- Produces: `editorAiRoute`, mounted at `/api/v1/editor`, with `POST /ai` returning `{ revision: EditorAiRevision }`.
- Produces: `resolveEditorResourceContext(db, userId, resourceKind, resourceId)` returning authoritative context plus `targetTable` or `null`.

- [ ] **Step 1: Add failing route integration coverage**

Create `studio/tests/integration/editor-ai.test.ts`. Use `SELF.fetch`, `env.DB`, `env.KV`, and `fetchMock` from `cloudflare:test`. The setup must:

```ts
import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://gateway.test")
    .intercept({ method: "POST", path: "/chat/completions" })
    .reply(
      200,
      JSON.stringify({
        choices: [{ message: { content: "Gateway replacement." } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
      { headers: { "content-type": "application/json" } },
    );
});

afterEach(() => fetchMock.deactivate());
```

Create an authenticated user through `/api/auth/sign-up/email`, query its ID from D1 by email, and insert one owned project/chapter, blog/post, and script/scene with explicit UUIDs. For each resource kind, POST this payload and assert `200`, the correct `target_table` in D1, and `before_md`/`after_md`:

```ts
const payload = (resource_kind: "chapter" | "blog-post" | "script-scene", resource_id: string) => ({
  resource_kind,
  resource_id,
  command: "proofread",
  scope: "document",
  target_md: "Original prose.",
  context_md: "Original prose.",
});
```

Also cover unauthenticated `401`, another user's `404`, deleted-parent `404`, invalid rewrite `400`, gateway failure without a revision row, and budget exhaustion `402`. Populate the free-plan KV budget key as:

```ts
await env.KV.put(`budget:${userId}:${new Date().toISOString().slice(0, 10)}`, "1000");
```

- [ ] **Step 2: Run the route test and confirm it fails**

Run:

```bash
cd studio
pnpm --filter web test -- ../../tests/integration/editor-ai.test.ts
```

Expected: FAIL with `404` because `/api/v1/editor/ai` is not mounted.

- [ ] **Step 3: Add test AI Gateway bindings**

Extend the existing `miniflare.bindings` object in `studio/apps/web/vitest.config.ts`:

```ts
bindings: {
  TEST_MIGRATIONS: migrations,
  KEYRING_MASTER_KEY: "test-keyring-master-key",
  AI_GATEWAY_BASE_URL: "https://gateway.test",
  AI_GATEWAY_TOKEN: "test-token",
},
```

- [ ] **Step 4: Implement resource context resolution and the route**

Create `studio/apps/web/src/routes/editor-ai.ts`. Use three ownership-preserving joins:

```ts
// chapter: chapters -> projects -> optional voices
where(and(eq(chapters.id, resourceId), eq(projects.user_id, userId), isNull(projects.deleted_at)))

// blog post: blog_posts -> blogs
where(and(eq(blog_posts.id, resourceId), eq(blogs.user_id, userId), isNull(blogs.deleted_at)))

// script scene: script_scenes -> scripts
where(and(eq(script_scenes.id, resourceId), eq(scripts.user_id, userId), isNull(scripts.deleted_at)))
```

Return `null` for every missing/unowned/deleted resource. The route implementation must use this shape:

```ts
export const editorAiRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

editorAiRoute.use("*", requireUser);
editorAiRoute.post("/ai", enforceBudget("editor-ai"), async (c) => {
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 310_000) {
    return c.json({ error: "request too large" }, 413);
  }

  const request = editorAiRequestSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const resolved = await resolveEditorResourceContext(
    db,
    c.get("user").id,
    request.resource_kind,
    request.resource_id,
  );
  if (!resolved) return c.json({ error: "not found" }, 404);

  const result = await runEditorCommand(c.env, { request, context: resolved.context });
  const revision: EditorAiRevision = {
    id: crypto.randomUUID(),
    before_md: request.target_md,
    after_md: result.markdown,
    llm_response: result.llm_response,
  };
  await db.insert(revisions).values({
    id: revision.id,
    target_table: resolved.targetTable,
    target_id: request.resource_id,
    before_md: revision.before_md,
    after_md: revision.after_md,
    llm_response: revision.llm_response,
  });
  return c.json({ revision });
});
```

- [ ] **Step 5: Mount the route and guard the retained chapter revise endpoint**

In `studio/apps/web/src/index.ts`, import `editorAiRoute` and mount it:

```ts
app.route("/api/v1/editor", editorAiRoute);
```

In `studio/apps/web/src/routes/chapters.ts`, import `enforceBudget` and change the retained route declaration without changing its handler:

```ts
chaptersRoute.post("/:id/revise", enforceBudget("chapter-inline-revise"), async (c) => {
```

- [ ] **Step 6: Run integration and unit tests**

Run:

```bash
cd studio
pnpm --filter web test -- ../../tests/integration/editor-ai.test.ts ../../tests/integration/chapters.test.ts
pnpm test
```

Expected: editor-AI ownership/revision/budget tests pass; the existing 13 Worker integration files and 26 tests remain green, with the new file/tests added to those totals.

- [ ] **Step 7: Commit Task 2**

```bash
git add studio/apps/web/src/routes/editor-ai.ts studio/apps/web/src/index.ts studio/apps/web/src/routes/chapters.ts studio/apps/web/vitest.config.ts studio/tests/integration/editor-ai.test.ts
git commit -m "feat: add authenticated editor AI route"
```

---

### Task 3: Shared BlockNote AI controller, menus, dialogs, and safe replacement helpers

**Files:**

- Create: `studio/apps/web/client/components/editor-ai/commands.tsx`
- Create: `studio/apps/web/client/components/editor-ai/editor-ai-dialog.tsx`
- Create: `studio/apps/web/client/components/editor-ai/blocknote-ai-commands.tsx`
- Create: `studio/tests/unit/editor-ai-client.test.ts`
- Modify: `studio/apps/web/client/lib/api.ts:1-760`

**Interfaces:**

- Consumes: shared command/resource/scope/revision types from `@/shared/editor-ai` and `api.runEditorAiCommand`.
- Produces: `EDITOR_AI_MENU_ITEMS`, `needsInstructions(command)`, and `flattenReplacementBlocks(blocks)`.
- Produces: `BlockNoteAiCommands({ editor, resourceKind, resourceId, saveNow })` for use as a child of a `BlockNoteView` configured with `slashMenu={false}` and `formattingToolbar={false}`.
- `saveNow` has signature `() => Promise<unknown>` and must persist the editor's current document immediately.

- [ ] **Step 1: Write failing pure client-helper tests**

Create `studio/tests/unit/editor-ai-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EDITOR_AI_MENU_ITEMS,
  flattenReplacementBlocks,
  needsInstructions,
} from "../../apps/web/client/components/editor-ai/commands";

describe("editor AI client helpers", () => {
  it("matches the local blog command order and instruction rules", () => {
    expect(EDITOR_AI_MENU_ITEMS.map((item) => item.command)).toEqual([
      "write",
      "proofread",
      "cite",
      "rewrite",
    ]);
    expect(needsInstructions("write")).toBe("optional");
    expect(needsInstructions("rewrite")).toBe("required");
    expect(needsInstructions("proofread")).toBe("none");
  });

  it("flattens parsed replacement blocks while retaining links and hard breaks", () => {
    expect(
      flattenReplacementBlocks([
        { type: "paragraph", content: [{ type: "text", text: "First", styles: {} }] },
        {
          type: "paragraph",
          content: [{ type: "link", href: "https://example.com", content: "Source" }],
        },
      ]),
    ).toEqual([
      { type: "text", text: "First", styles: {} },
      "\n",
      { type: "link", href: "https://example.com", content: "Source" },
    ]);
  });
});
```

- [ ] **Step 2: Run the helper test and confirm it fails**

Run:

```bash
cd studio
pnpm vitest run tests/unit/editor-ai-client.test.ts
```

Expected: FAIL because the shared client command module does not exist.

- [ ] **Step 3: Add the typed client API method**

In `studio/apps/web/client/lib/api.ts`, import the shared request/revision types and add:

```ts
runEditorAiCommand: (input: EditorAiRequest, options?: { signal?: AbortSignal }) =>
  fetchJson<{ revision: EditorAiRevision }>("/api/v1/editor/ai", {
    method: "POST",
    body: JSON.stringify(input),
    signal: options?.signal,
  }),
```

- [ ] **Step 4: Implement menu metadata and replacement flattening**

Create `studio/apps/web/client/components/editor-ai/commands.tsx` with the four local-blog labels, subtext, aliases, and a shared Sparkles icon. Implement `needsInstructions` and `flattenReplacementBlocks` so selection Markdown parsed by BlockNote can be inserted as inline content separated by hard breaks. Reject blocks without array inline content rather than stringifying unsupported tables/files.

- [ ] **Step 5: Implement the accessible instruction/review dialog**

Create `studio/apps/web/client/components/editor-ai/editor-ai-dialog.tsx` using the existing `Button`, `Textarea`, and `Alert` primitives. Render a fixed, keyboard-operable dialog with:

```ts
type EditorAiDialogProps = {
  state: EditorAiUiState;
  onChoose: (command: EditorAiCommand) => void;
  onSubmitInstructions: (instructions?: string) => void;
  onApply: () => void;
  onReject: () => void;
  onRetry: () => void;
};
```

The dialog must render `role="dialog"`, `aria-modal="true"`, an accessible title, a before/after `<pre>` diff, `Apply`, `Reject`, and `Retry`, and the citation disclosure from the spec when `command === "cite"`.

- [ ] **Step 6: Implement the BlockNote command controller**

Create `studio/apps/web/client/components/editor-ai/blocknote-ai-commands.tsx`. Its state machine must be explicit:

```ts
type EditorAiUiState =
  | { stage: "idle" }
  | { stage: "choose"; scope: "selection" }
  | { stage: "instructions"; run: CapturedRun; requirement: "optional" | "required" }
  | { stage: "loading"; run: CapturedRun }
  | { stage: "review"; run: CapturedRun; revision: EditorAiRevision }
  | { stage: "error"; run: CapturedRun; message: string };
```

For selection scope, capture both `editor.getSelectionCutBlocks()` Markdown and this bookmark before opening UI:

```ts
const selection = editor.prosemirrorState.selection;
if (selection.empty) return;
bookmarkRef.current = selection.getBookmark();
editor.isEditable = false;
```

Before Apply, restore it against the unchanged document and replace only that range:

```ts
editor.transact((tr) => {
  const bookmark = bookmarkRef.current;
  if (!bookmark) throw new Error("Selected text is no longer available");
  tr.setSelection(bookmark.resolve(tr.doc));
});
const blocks = editor.tryParseMarkdownToBlocks(revision.after_md);
editor.insertInlineContent(flattenReplacementBlocks(blocks), { updateSelection: true });
```

For document scope:

```ts
const blocks = editor.tryParseMarkdownToBlocks(revision.after_md);
if (blocks.length === 0) throw new Error("AI returned no usable blocks");
editor.replaceBlocks(editor.document, blocks);
```

After mutation, set `editor.isEditable = true`, clear the bookmark, await `saveNow()`, and close the dialog. Reject/error/unmount must restore editability without mutation. Maintain one `AbortController`; abort and ignore stale responses on retry or unmount.

Render a `SuggestionMenuController` that prepends AI items to `getDefaultReactSlashMenuItems(editor)`. Render a custom `FormattingToolbarController` whose toolbar includes `getFormattingToolbarItems()` plus one `AI commands` button. Clicking that button captures and locks the selection before the command chooser opens.

- [ ] **Step 7: Run helper tests, typecheck, and build**

Run:

```bash
cd studio
pnpm vitest run tests/unit/editor-ai-client.test.ts
pnpm --filter web typecheck
pnpm --filter web build
```

Expected: helper tests pass, TypeScript accepts the BlockNote bookmark and inline-content types, and the web bundle builds without adding a dependency.

- [ ] **Step 8: Commit Task 3**

```bash
git add studio/apps/web/client/components/editor-ai studio/apps/web/client/lib/api.ts studio/tests/unit/editor-ai-client.test.ts
git commit -m "feat: add shared BlockNote AI controls"
```

---

### Task 4: Integrate the shared controls with the chapter editor

**Files:**

- Modify: `studio/apps/web/client/components/panels/ChapterEditorPanel.tsx:93-335`
- Modify: `studio/tests/e2e/chapter-editor.spec.ts:1-110`

**Interfaces:**

- Consumes: `BlockNoteAiCommands` and its `saveNow: () => Promise<unknown>` adapter from Task 3.
- Preserves: existing `InlineAiPanel`, section drafting, `DiffPreview`, chapter save-state UI, and `reviseChapterSelection` behavior.

- [ ] **Step 1: Extend the chapter browser test with the slash-menu contract**

In `studio/tests/e2e/chapter-editor.spec.ts`, intercept only the new endpoint:

```ts
await page.route("**/api/v1/editor/ai", async (route) => {
  const request = route.request().postDataJSON();
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
```

After the editor opens, type `/`, assert `Write`, `Proofread`, `Cite`, and `Rewrite` in the `AI` suggestion group, choose `Proofread`, assert the diff, Reject, and verify the chapter text is unchanged. Then select a partial sentence, open `AI commands` from the formatting toolbar, choose `Rewrite`, provide instructions, Apply, and assert only the selected sentence becomes `Sharper selected prose.` and the `Saved` state appears.

- [ ] **Step 2: Run the focused browser test and confirm it fails**

Run against a local app:

```bash
cd studio
E2E_BASE_URL=http://localhost:5173 pnpm test:e2e -- chapter-editor.spec.ts
```

Expected: FAIL because no shared AI slash-menu group or selection-toolbar control is rendered.

- [ ] **Step 3: Add an immediate chapter save adapter**

In `ChapterEditorInner`, factor the existing save behavior into a callback that clears the debounce before calling the mutation:

```ts
async function saveNow() {
  if (pendingSave.current) {
    window.clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
  }
  return saveMutation.mutateAsync();
}
```

Use `saveNow` for the existing `Save now` button and the new AI adapter so an older debounce cannot race an accepted replacement.

- [ ] **Step 4: Mount shared BlockNote controls without removing legacy AI**

Update the chapter `BlockNoteView`:

```tsx
<BlockNoteView
  editor={editor}
  formattingToolbar={false}
  slashMenu={false}
  theme={darkMode ? "dark" : "light"}
  onChange={scheduleExistingChapterSave}
>
  <BlockNoteAiCommands
    editor={editor}
    resourceId={chapter.id}
    resourceKind="chapter"
    saveNow={saveNow}
  />
</BlockNoteView>
```

Keep `InlineAiPanel` mounted exactly where it is. Ensure both the legacy panel and BlockNote's custom formatting toolbar prevent selection loss independently.

- [ ] **Step 5: Run chapter tests and checks**

Run:

```bash
cd studio
pnpm --filter web typecheck
pnpm vitest run tests/unit/writer.test.ts tests/unit/editor-ai-client.test.ts
E2E_BASE_URL=http://localhost:5173 pnpm test:e2e -- chapter-editor.spec.ts
```

Expected: existing inline AI assertions still pass, new command assertions pass, and TypeScript remains clean.

- [ ] **Step 6: Commit Task 4**

```bash
git add studio/apps/web/client/components/panels/ChapterEditorPanel.tsx studio/tests/e2e/chapter-editor.spec.ts
git commit -m "feat: add AI commands to chapter editor"
```

---

### Task 5: Integrate the shared controls with blog-post and script-scene editors

**Files:**

- Modify: `studio/apps/web/client/routes/_hub.blogs.$blogId.posts.$postId.tsx:59-250`
- Modify: `studio/apps/web/client/routes/_hub.scripts.$scriptId.scenes.$sceneId.tsx:91-264`
- Create: `studio/tests/e2e/blocknote-ai-editors.spec.ts`

**Interfaces:**

- Consumes: `BlockNoteAiCommands` and the `saveNow` adapter from Task 3.
- Preserves: each editor's `pendingSave`, `inFlight`, `gen`, dirty/save-state, status promotion, query invalidation, markdown hydration, and unmount flush behavior.

- [ ] **Step 1: Add parameterized UI coverage for post and scene editors**

Create `studio/tests/e2e/blocknote-ai-editors.spec.ts`. Sign up once per test, create and plan a blog/script through authenticated `/api/v1` requests from `page.request`, then navigate to `/blogs/{blogId}/posts/{postId}` and `/scripts/{scriptId}/scenes/{sceneId}`. Intercept `/api/v1/editor/ai` with the same deterministic revision response used by the chapter test.

For both editors, assert:

```ts
for (const command of ["Write", "Proofread", "Cite", "Rewrite"]) {
  await expect(page.getByText(command, { exact: true })).toBeVisible();
}
```

Then verify document-scope Reject leaves content intact, selection-scope Apply changes only selected text, accepted output reaches the editor's existing PATCH autosave endpoint, dark mode keeps the dialog readable, and Escape closes instruction UI while restoring editability.

- [ ] **Step 2: Run the new browser test and confirm it fails**

Run:

```bash
cd studio
E2E_BASE_URL=http://localhost:5173 pnpm test:e2e -- blocknote-ai-editors.spec.ts
```

Expected: FAIL because post and scene `BlockNoteView` instances still use only BlockNote's default UI.

- [ ] **Step 3: Add a safe `saveNow` adapter to the blog-post editor**

Inside the blog `Editor`, add:

```ts
async function saveNow() {
  if (pendingSave.current) {
    window.clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
  }
  return saveDraft.mutateAsync();
}
```

Mount `BlockNoteAiCommands` inside `BlockNoteView` with `resourceKind="blog-post"`, `resourceId={post.id}`, `formattingToolbar={false}`, and `slashMenu={false}`. Leave title/summary autosave, body mutation, and unmount flush unchanged.

- [ ] **Step 4: Add a safe `saveNow` adapter to the script-scene editor**

Inside the script `Editor`, add the same pending-timer cancellation around `saveDraft.mutateAsync()`. Mount `BlockNoteAiCommands` with `resourceKind="script-scene"`, `resourceId={scene.id}`, `formattingToolbar={false}`, and `slashMenu={false}`. Leave page estimation, status promotion, query invalidation, and unmount flush unchanged.

- [ ] **Step 5: Run UI, type, and build verification**

Run:

```bash
cd studio
pnpm --filter web typecheck
pnpm --filter web build
E2E_BASE_URL=http://localhost:5173 pnpm test:e2e -- blocknote-ai-editors.spec.ts chapter-editor.spec.ts
```

Expected: both new editor surfaces expose the same commands and selection behavior, the prior chapter flow remains green, and the production client builds.

- [ ] **Step 6: Commit Task 5**

```bash
git add 'studio/apps/web/client/routes/_hub.blogs.$blogId.posts.$postId.tsx' 'studio/apps/web/client/routes/_hub.scripts.$scriptId.scenes.$sceneId.tsx' studio/tests/e2e/blocknote-ai-editors.spec.ts
git commit -m "feat: add AI commands to post and scene editors"
```

---

### Task 6: Full verification, accessibility pass, review, and delivery

**Files:**

- Modify only files from Tasks 1-5 when verification reveals a defect.
- Update: `docs/superpowers/plans/2026-07-17-blocknote-ai-commands.md` by checking completed steps.

**Interfaces:**

- Consumes the complete feature from Tasks 1-5.
- Produces a review-ready branch with no uncommitted changes, a passing CI-equivalent test set, and a PR that can be merged.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
cd studio
pnpm lint
pnpm typecheck
pnpm build
```

Expected: Biome, all workspace TypeScript projects, and the production build pass.

- [ ] **Step 2: Run all unit and Worker integration tests**

Run:

```bash
cd studio
pnpm test
```

Expected: all pre-existing and new unit/integration tests pass with no failed files.

- [ ] **Step 3: Run the relevant browser suite**

Run:

```bash
cd studio
E2E_BASE_URL=http://localhost:5173 pnpm test:e2e -- chapter-editor.spec.ts blocknote-ai-editors.spec.ts
```

Expected: chapter, blog-post, and script-scene command flows pass for slash-menu document scope, selection-toolbar scope, Apply, Reject, Retry/error recovery, autosave, dark mode, and focus restoration.

- [ ] **Step 4: Manually inspect the three editor surfaces**

At desktop and narrow widths, verify:

- the AI group precedes default slash commands;
- the formatting toolbar retains all default controls and fits without clipping;
- instruction and diff dialogs remain readable in light and dark themes;
- loading state prevents edits and exposes an accessible busy label;
- Apply restores focus and editing; Reject, Escape, gateway error, and navigation never mutate text;
- citation review clearly says sources are AI-generated suggestions and require author review.

- [ ] **Step 5: Run a focused code review and fix every actionable finding**

Review the diff against `docs/superpowers/specs/2026-07-17-blocknote-ai-commands-design.md`. Specifically inspect authorization joins, request caps, gateway route selection, revision writes, bookmark lifetime, abort cleanup, autosave races, and preservation of default BlockNote UI.

After fixes, rerun:

```bash
cd studio
pnpm lint
pnpm typecheck
pnpm test
```

Expected: no actionable review findings remain and all checks pass.

- [ ] **Step 6: Commit verification fixes**

```bash
git add studio docs/superpowers/plans/2026-07-17-blocknote-ai-commands.md
git commit -m "test: verify BlockNote AI command workflows"
```

- [ ] **Step 7: Push, open a pull request, resolve review/CI, and merge**

```bash
git push -u origin codex/blocknote-ai-commands
gh pr create --title "feat: add AI commands to BlockNote editors" --body-file /tmp/blocknote-ai-pr-body.md
gh pr checks --watch
```

The PR body must summarize all three editor integrations, server ownership and budget protection, revision auditing, and the exact test commands run. Address every review comment, resolve conflicts against `origin/main`, rerun the full verification set, and merge only after required checks pass.
