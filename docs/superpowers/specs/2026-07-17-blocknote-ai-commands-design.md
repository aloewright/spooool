# BlockNote AI Commands — Design Spec

## Goal

Add the local blog project's proven BlockNote AI-command interaction to all three Spooool BlockNote editors:

- book chapters;
- blog posts; and
- script scenes.

Authors can invoke `Write`, `Proofread`, `Cite`, and `Rewrite` without leaving the editor. Commands operate on selected text when invoked from the selection toolbar and on the whole document when invoked from the slash menu. Generated changes are never saved until the author reviews and applies a diff.

## Existing behavior

Spooool currently has three separate BlockNote integrations:

- `ChapterEditorPanel` has an editor-specific selection toolbar for rewrite, tighten, expand, tone, and grammar actions, plus a diff preview.
- The blog-post editor has BlockNote and autosave but no in-editor AI commands.
- The script-scene editor has BlockNote and autosave but no in-editor AI commands.

The local `/Users/aloe/blog` project customizes BlockNote's slash menu with an `AI` group containing `Write post`, `Proofread`, `Cite`, and `Rewrite`. It routes commands through a Worker-side AI Gateway adapter, locks the editor during a request, aborts work on unmount, converts the result from Markdown back into BlockNote blocks, and reports errors without mutating content.

Spooool differs in one important respect: all three editors autosave. Directly replacing content as soon as a model responds would persist an unreviewed generation. Spooool therefore adds a required review step while preserving the local blog's command names and menu pattern.

## Approved direction

Build one shared Spooool-native AI-command layer rather than three editor-specific implementations or an `@blocknote/xl-ai` integration.

The shared layer owns:

- command metadata and aliases;
- the custom slash-menu controller;
- the selection-toolbar AI entry;
- instruction dialogs;
- request, cancellation, and busy state;
- the before/after diff review;
- safe application of a replacement; and
- a typed client API contract.

Each editor supplies a small adapter containing its resource identity, current metadata, BlockNote editor instance, editor container, and save callback. Server-side code resolves authoritative resource context and ownership from D1.

## Commands

The command set matches the local blog:

| Command | Instructions | Behavior |
| --- | --- | --- |
| Write | Optional | Writes a complete document when invoked from the slash menu. When invoked on a selection, writes a replacement passage informed by the selected passage and surrounding document. |
| Proofread | None | Corrects grammar, spelling, punctuation, and awkward phrasing while preserving meaning, voice, structure, links, and formatting. |
| Cite | None | Adds supportable inline citations and a Markdown-linked sources list while otherwise preserving the target text. |
| Rewrite | Required | Rewrites the target according to the author's instructions while preserving factual content and important links. |

`Write` can run against an empty whole document when the resource has a title or other server-resolved planning context. The other commands require non-empty target content.

## Invocation and targeting

### Whole document

`BlockNoteView` disables its built-in slash menu and mounts a shared `SuggestionMenuController`. The controller prepends an `AI` group to `getDefaultReactSlashMenuItems(editor)` and filters the combined list with BlockNote's standard filtering helper.

Typing `/` cannot preserve a pre-existing text selection because the typed character replaces that selection. Slash-menu commands therefore always target the whole document.

### Selection

When BlockNote has a non-empty text selection, its formatting toolbar includes an `AI` control alongside the standard formatting controls. The control exposes the same four commands. Selection-toolbar commands target only the selected passage.

The command handler captures the target text and calls `editor.prosemirrorState.selection.getBookmark()` before any instruction dialog opens. Mouse-down handling prevents the toolbar interaction from collapsing prematurely. From command start through Apply or Reject, the editor is read-only, so no document transaction can invalidate the saved bookmark. Immediately before Apply, a BlockNote transaction resolves the bookmark against the unchanged document and restores that exact text range.

Selection replacements use BlockNote's retained ProseMirror selection and inline-content insertion path. Returned selection Markdown is parsed through BlockNote first so text styles and links become inline content; when a selection response contains several blocks, their inline content is joined with hard breaks before insertion. Whole-document replacements parse returned Markdown into blocks and replace the current document. Empty or unparsable output is never applied.

## User flow

1. The author invokes a command from the slash menu or selection toolbar.
2. `Write` opens an optional-instructions dialog. `Rewrite` opens a required-instructions dialog. `Proofread` and `Cite` start immediately.
3. The shared controller snapshots the target and full-document Markdown, makes the editor read-only, and sends the request.
4. The Worker returns replacement Markdown and route/token metadata.
5. The client shows a before/after diff with `Apply`, `Reject`, and `Retry` actions.
6. `Apply` replaces exactly the captured scope, restores editing, and calls the editor's existing immediate-save path. `Reject` restores editing without changing content. `Retry` reruns the same command and scope.
7. Navigation or unmount aborts an in-flight request. A gateway, validation, or parse error restores editing and leaves the document untouched.

The command surface communicates `Working`, `Ready to review`, and error states accessibly. Dialogs are keyboard operable, focus is returned to the editor after dismissal, and busy controls expose `aria-busy` or disabled state as appropriate.

## Client architecture

Create a focused shared module under `studio/apps/web/client/components/editor-ai/`:

- command types and menu metadata;
- a controller hook for request, abort, dialog, review, and apply state;
- a custom slash-menu controller;
- a custom formatting toolbar that retains BlockNote's default controls and adds the AI control;
- the instruction dialog; and
- the diff review UI.

The public adapter contract contains:

- `resourceKind`: `chapter | blog-post | script-scene`;
- `resourceId`;
- the BlockNote editor instance;
- server-relevant display metadata used only for UI labels;
- a way to read the full current document as Markdown;
- an editor-root reference used to detect a non-empty text selection; and
- `saveNow`, which invokes the host editor's existing save mutation after Apply.

`BlockNoteAiCommands` is rendered inside each `BlockNoteView`. It does not own or duplicate editor autosave logic.

The chapter editor keeps its existing inline toolbar in this change. That toolbar continues to use the existing `reviseInlineText` path, including its current deterministic local-development fallback. The new four-command interface uses the new editor-command skill and does not silently change the older toolbar's generation behavior. Consolidating the two command sets can be considered separately after the shared BlockNote surface is proven.

## API contract

Add authenticated `POST /api/v1/editor/ai` with a strict Zod schema.

Request fields:

```ts
type EditorAiRequest = {
  resource_kind: "chapter" | "blog-post" | "script-scene";
  resource_id: string;
  command: "write" | "proofread" | "cite" | "rewrite";
  scope: "document" | "selection";
  target_md: string;
  context_md: string;
  instructions?: string;
};
```

Response fields:

```ts
type EditorAiResponse = {
  revision: {
    id: string;
    before_md: string;
    after_md: string;
    llm_response: {
      route: "dynamic/text_gen" | "dynamic/research_gen";
      tokens_in: number;
      tokens_out: number;
    };
  };
};
```

The client supplies live `context_md` because it may contain debounced edits not yet present in D1. The Worker never trusts the client for ownership, title, format, voice, or planning metadata.

## Server architecture

Add an editor-AI route and a single editor-command skill. The route:

1. requires an authenticated user and applies the existing daily AI-budget middleware;
2. validates input size and command-specific requirements;
3. loads the target and its parent resource from D1;
4. verifies that the authenticated user owns a non-deleted parent resource;
5. assembles authoritative content-type context;
6. calls the shared skill; and
7. records a revision audit entry before returning the generated replacement.

Context varies by resource:

- Chapter: project title/type, chapter title/summary, and project voice profile.
- Blog post: blog title/description/format, post title/summary, voice profile, and do/don't rules.
- Script scene: script title, format, logline, genre, scene title/summary, and scene ordinal.

The skill builds command-specific prompts with a content-type system prompt. User-authored document content is delimited as source material and is not treated as system instruction.

`Write`, `Proofread`, and `Rewrite` use `dynamic/text_gen`. `Cite` uses Spooool's configured `dynamic/research_gen` route and instructs the route to add only sources it can support, never placeholder or invented URLs. Citation results are still presented as AI-generated suggestions in the diff; the UI does not claim that Spooool independently verified a source or that it supports the associated claim. All provider calls continue through the existing AI Gateway client with zero-data-retention headers; no provider SDK or new secret is introduced.

The route stores successful results in the existing `revisions` table with `target_table` set to `chapters`, `blog_posts`, or `script_scenes`. A revision is an audit record of the proposal, not proof that the client applied it.

The retained chapter `/:id/revise` route receives the same budget middleware in this change so the older inline toolbar cannot bypass the quota enforced by the new editor command surface. Its prompt construction, response contract, revision behavior, and deterministic fallback otherwise remain unchanged. Section drafting is a separate generation workflow and is not migrated by this feature.

## Validation and failure handling

- Cap request-body size before parsing.
- Cap target Markdown, document context, titles, descriptions, and instructions independently.
- Require instructions for `Rewrite`.
- Permit an empty target only for whole-document `Write` with usable server-side planning context.
- Reject empty, oversized, or unusable gateway output.
- Remove only a whole-response Markdown fence; do not sanitize away valid Markdown structure.
- Return `404` for a missing or unowned resource without revealing which condition failed.
- Return budget and authentication failures through existing middleware behavior.
- The new editor-command skill does not use deterministic placeholder prose as an AI fallback. A failed command call is visible as an error and never changes editor content. This requirement does not alter the retained chapter inline service's existing local-development fallback.
- Abort on unmount and ignore late responses from superseded runs.
- Keep the editor read-only until Apply, Reject, or terminal error to avoid applying a result to a changed target.

## Autosave integration

Each host editor exposes an immediate-save function backed by its existing mutation:

- chapter: serialize blocks and call `updateChapter`;
- blog post: serialize blocks and call `updateBlogPost`;
- script scene: serialize blocks and call `updateScriptScene`.

Before applying an AI result, the host cancels or supersedes any older in-flight autosave using its existing abort/generation guard. Apply mutates BlockNote, then calls the immediate-save function. Existing `onChange` debounce may also fire, but its generation guard prevents an older payload from landing after the accepted result.

Reject and request failure never invoke save. The save status shown by each editor remains the source of truth for persistence.

## Testing

### Shared client tests

- AI items precede default BlockNote slash-menu items and filter by title and aliases.
- Slash-menu invocation uses document scope.
- A non-empty selection exposes the AI formatting-toolbar control and uses selection scope.
- Selection scope captures a ProseMirror bookmark, survives instruction-dialog and review focus changes, and restores the exact partial-text or cross-block range before Apply.
- `Write` accepts empty optional instructions; `Rewrite` blocks empty instructions.
- The editor is read-only while generating and reviewing, then restored after Apply, Reject, abort, or error.
- Apply replaces only the selection for selection scope and the full block document for document scope.
- Reject, malformed output, and gateway failure do not mutate or save content.
- Apply invokes `saveNow` exactly once.
- Unmount aborts the request and a late response cannot mutate a new editor instance.

### Server unit tests

- Request validation covers every command, scope, cap, and empty-content rule.
- Prompt construction is content-type aware and includes saved voice/format context.
- Selection prompts request only replacement text; document prompts request the complete body.
- `Cite` uses `dynamic/research_gen`; the other commands use `dynamic/text_gen`.
- Whole-response fences are removed and empty output is rejected.

### Route integration tests

- Authentication and ownership are enforced for chapters, posts, and scenes.
- Deleted parent resources cannot be used.
- Each resource kind loads the correct authoritative context.
- Successful calls record revisions with the correct target table and gateway metadata.
- Validation, budget, and gateway failures do not write revisions or document changes.

### Editor integration and browser tests

- Run each command from every editor's slash menu.
- Run each command against a text selection from every editor's formatting toolbar.
- Verify diff Apply, Reject, Retry, autosave, navigation abort, dark mode, keyboard interaction, and focus restoration.
- Confirm BlockNote's standard slash-menu and formatting controls still work.
- Run the Studio unit/integration suites, type checks, lint, and the relevant Playwright editor tests.

## Out of scope

- Streaming model tokens into BlockNote.
- Adding more commands such as shorten, expand, or tone presets to posts and scenes.
- Removing the chapter editor's existing inline-AI toolbar.
- Consolidating the older chapter inline actions into the new editor-command skill.
- Automatically applying or saving an AI result before review.
- Direct provider calls or a new AI SDK.
- Persisting rejected proposals as document content.
- Changing project planning, publishing, or generation workflows outside the three editors.

## Acceptance criteria

- All three BlockNote editors expose the same four AI commands in an `AI` slash-menu group.
- Selected text exposes the same commands in the floating formatting toolbar.
- Selection commands affect only the selected passage; slash commands affect the complete document.
- Every result requires explicit review and Apply before autosave.
- Errors, rejection, cancellation, and navigation leave document content unchanged.
- Server-side authentication, ownership, budget enforcement, authoritative context, AI Gateway routing, and revision logging are covered by tests.
- Existing BlockNote commands, formatting controls, autosave behavior, and the chapter inline-AI toolbar continue to work.
