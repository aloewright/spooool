# Studio v2 Parity Audit — 2026-05-10

## Confirmed parity
- Concept/Scout (legacy `/projects/$id` Concept tab → `/studio/$id/marketplace?tab=scout`). Both render `ConceptScoutPanel`.
- Voice library (`/projects/$id` Voice tab → `/studio/$id/voice`). Both render `VoicePanel`.
- Outline (`/projects/$id` Outline/Chapters tabs → `/studio/$id/outline`). Both still render the same tabbed `OutlineBuilder` today; the Q&A snap-scroll replacement lands in Phase 1.
- Publisher pack (`/projects/$id` Publish tab → `/studio/$id/marketplace?tab=publish`). Both render `PublishPanel`.
- GTM brief / Launch (`/projects/$id/launch` → `/studio/$id/marketplace?tab=launch`). Both render `LaunchPanel` (studio inlines it; legacy wraps in its own page chrome).
- Project list + create (`/dashboard` → `/studio` index). Both list `api.listProjects()` and create via `api.createProject`. Studio uses `/studio/compose` for the multi-step create wizard; dashboard does inline create.

## Gaps
- **Chapter editor** — `/projects/$id/chapters/$chapterId` has the BlockNote rich editor (`@blocknote/mantine` + `useCreateBlockNote`), `SectionDraftPanel` (per-section draft/redraft with `api.draftSection`), `InlineAiPanel` (selection-based rewrite/tighten/expand/change-tone "Punchy"/fix-grammar via `api.reviseChapterSelection`), `DiffPreview` (before/after side-by-side), debounced autosave via `api.updateChapter`, and `ChapterStats` badge (words vs target). Studio's canvas only shows per-section textareas (`SceneCard`) with autosave — no rich editor, no inline AI, no diff review, no chapter-level draft. Closed by Tasks 2.1 + 2.2.
- **Full-book view** — `/projects/$id/book` has assembled manuscript (`api.getFullBook`), jump-to-chapter nav (`BookMenu`), inline mobile menu, "Edit" deep-link per chapter, `ReadinessRow`s, and export trigger via `api.startBookExport` with `api.listRenderJobs` polling (3s when queued/running). No studio equivalent yet. Closed by Tasks 2.3 + 2.4.
- **AI assistant** — Legacy `/projects/$id` and `/projects/$id/chapters/$chapterId` both mount `EditorialAssistantSidecar` (always-on right panel) which connects to the `BookProjectAgent` durable object via `useAgent({ agent: "aloysius", name: projectId })` and `useAgentChat` — the agent route is `/agents/aloysius/$projectId` (DO export name = `BookProjectAgent`, but the URL/binding slug is `aloysius`). Studio shows an inert `AiOrb` instead. Closed by Task 2.5 (note: the plan template referenced `/agents/book-project-agent/$projectId`; the correct path is `/agents/aloysius/$projectId`).
- **BottomToolbar buttons** — Studio canvas renders four inert buttons: Insert, Remix, Voice, Background, plus a Settings2 affordance. The per-chapter `InsertBar` already works (Blank scene / Start with template / Generate with AI) — only the global bottom dock is inert. Closed by Task 2.6.
- **TopRightPill buttons** — Share, Export, Read aloud are inert; Settings2 affordance is also inert; the "H" avatar is a static visual. Closed by Task 2.7.
- **Dashboard project deletion + restore** — `dashboard.tsx` has `api.deleteProject` (per-card trash icon) + a "Recently deleted" section using `api.listDeletedProjects` + `api.restoreProject` with a 30-day retention copy. `studio.index.tsx` has neither. Closed by Task 2.8.
- **Open-chapter affordance from canvas** — Legacy `OutlineRail` + `WorkflowHeader` route into the chapter editor (and `book.tsx`'s manuscript has per-chapter Edit links). Studio canvas's `SceneCard` has no link out to a chapter editor — chapters are only addressable via scene textareas inline. Closed alongside Task 2.2.

## Out of scope (intentional drop)
- **Workflow status header tiles** (`WorkflowHeader` + `ReadinessTile` for concept/voice/outline/publisher readiness; in `/projects/$id` only). Studio's `BreadcrumbPill` subtitle + `SideDrawer` "This book" section covers the same wayfinding more compactly. The `nextWorkflowAction` CTA card from `WorkflowHeader` is also dropped.
- **Workflow rail with 7 modes** (`OutlineRail`: Concept / Voice / Outline / Chapters / Book / Publish / Launch with child accordions). Replaced by `SideDrawer` (Home / New book / Voices + per-book: Canvas / Outline / Marketplace / Voice). Marketplace consolidates Scout + Launch + Publish into one route with tabs.
- **Hash-based workflow routing** (`#outline:setup`, `#publish:metadata`, etc.) Replaced by file-route + search params (`/studio/$id/marketplace?tab=launch`).
- **Per-section "drafted" status copy** in the canvas — studio uses inline save indicator only; legacy shows section status badges.
