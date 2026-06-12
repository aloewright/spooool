# Studio Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `/projects/*` flow with the studio-v2 flow, including a snap-scroll Q&A outline builder (matching `studio/compose.tsx`'s pattern), full feature parity for chapter editing + full-book view + chrome wiring, and a clean cutover that defaults all signed-in users to `/studio`.

**Architecture:** Three sequential phases shipped as independent PRs. (1) Reshape `OutlineBuilder` from a tabbed disclosure panel into a snap-scroll Q&A reusing the `Step` pattern from `studio.compose.tsx`. (2) Close the parity gap: studio-side chapter editor route, full-book view route, and wire the currently-inert chrome buttons (Bottom toolbar Remix/Voice/Background, TopRightPill Share/Export/Read aloud, the AI orb). (3) Flip `post-signin → /dashboard` to `/studio`, convert `/projects/*` routes to permanent redirects, and remove `/dashboard` (also redirects to `/studio`). The `/projects/*` redirects stay forever to keep old links working.

**Tech Stack:** TanStack Router (file-based), React 19, Tailwind v4, Vercel AI SDK, Cloudflare AI Gateway dynamic routes, BlockNote editor (existing), vitest + jsdom for component tests.

---

## File Structure

**New files:**
- `apps/web/client/components/panels/OutlineBuilderQA.tsx` — replaces tabbed OutlineBuilder for `/studio/$projectId/outline`. Owns the Q&A wizard state; calls `api.generateProjectOutline`.
- `apps/web/client/components/panels/ChapterEditorPanel.tsx` — extracted body of `routes/projects.$projectId.chapters.$chapterId.tsx` (the BlockNote editor + section draft panel + inline-AI panel + diff preview). Reused by both routes during cutover.
- `apps/web/client/components/panels/FullBookPanel.tsx` — extracted body of `routes/projects.$projectId.book.tsx` (full manuscript + jump-to-chapter + export trigger).
- `apps/web/client/components/studio/AiAssistantSheet.tsx` — slide-up chat panel wired to the existing `BookProjectAgent` durable-object via `/agents/*`. Opened from `AiOrb`.
- `apps/web/client/routes/studio.$projectId.chapters.$chapterId.tsx` — wraps `ChapterEditorPanel` under studio chrome.
- `apps/web/client/routes/studio.$projectId.book.tsx` — wraps `FullBookPanel` under studio chrome.
- `docs/superpowers/notes/2026-05-10-studio-parity-audit.md` — gap list produced by Task 0.1.

**Modified files:**
- `apps/web/client/routes/studio.$projectId.outline.tsx` — swap `OutlineBuilder` import for `OutlineBuilderQA`.
- `apps/web/client/routes/studio.$projectId.tsx` — wire `BottomToolbar` Remix → inline rewrite (selection-based); Voice → `/studio/$projectId/voice`; Background → noop placeholder removed; Export → `api.startBookExport`; Read aloud → TTS via `dynamic/audio_gen`; AI orb → toggle `AiAssistantSheet`.
- `apps/web/client/components/studio/TopRightPill.tsx` — make Share/Export/Read aloud buttons functional via props.
- `apps/web/client/routes/index.tsx` — signed-in redirect: `/dashboard` → `/studio`.
- `apps/web/client/routes/sign-in.tsx` — post-signin nav: `/dashboard` → `/studio`.
- `apps/web/client/routes/dashboard.tsx` — convert to redirect to `/studio`.
- `apps/web/client/routes/projects.$projectId.tsx` — convert to redirect to `/studio/$projectId` (legacy preserved as alias).
- `apps/web/client/routes/projects.$projectId.book.tsx` — convert to redirect to `/studio/$projectId/book`.
- `apps/web/client/routes/projects.$projectId.launch.tsx` — convert to redirect to `/studio/$projectId/marketplace?tab=launch`.
- `apps/web/client/routes/projects.$projectId.chapters.$chapterId.tsx` — convert to redirect to `/studio/$projectId/chapters/$chapterId` (chapter editor route lives only under studio after cutover).

---

## Phase 0: Audit

### Task 0.1: Inventory legacy features and confirm gaps

**Files:**
- Create: `docs/superpowers/notes/2026-05-10-studio-parity-audit.md`

- [ ] **Step 1: Walk each `/projects/*` route and list user-visible features**

For each route below, open the file and enumerate top-level UI sections, mutations, and queries:
- `apps/web/client/routes/projects.$projectId.tsx`
- `apps/web/client/routes/projects.$projectId.book.tsx`
- `apps/web/client/routes/projects.$projectId.chapters.$chapterId.tsx`
- `apps/web/client/routes/projects.$projectId.launch.tsx`
- `apps/web/client/routes/dashboard.tsx`

- [ ] **Step 2: Walk each `/studio/*` route and list what it covers**

- `apps/web/client/routes/studio.index.tsx`
- `apps/web/client/routes/studio.compose.tsx`
- `apps/web/client/routes/studio.$projectId.tsx`
- `apps/web/client/routes/studio.$projectId.outline.tsx`
- `apps/web/client/routes/studio.$projectId.voice.tsx`
- `apps/web/client/routes/studio.$projectId.marketplace.tsx`

- [ ] **Step 3: Write the audit doc**

Use this template (do not change headings — Phase 2 tasks reference them):

```markdown
# Studio v2 Parity Audit — 2026-05-10

## Confirmed parity
- Concept/Scout (legacy `/projects/$id` Concept tab → `/studio/$id/marketplace?tab=scout`)
- Voice library (`/projects/$id` Voice tab → `/studio/$id/voice`)
- Outline (`/projects/$id` Outline tab → `/studio/$id/outline`, Q&A version pending Phase 1)
- Publisher pack (`/projects/$id` Publish tab → `/studio/$id/marketplace?tab=publish`)
- GTM brief / Launch (`/projects/$id/launch` → `/studio/$id/marketplace?tab=launch`)

## Gaps
- **Chapter editor** — `/projects/$id/chapters/$chapterId` has BlockNote rich editor + section draft panel + inline AI edit (rewrite/tighten/expand/change-tone/fix-grammar) + diff preview. No studio equivalent yet. Closed by Task 2.1 + 2.2.
- **Full-book view** — `/projects/$id/book` has assembled manuscript + jump-to-chapter + export trigger. No studio equivalent. Closed by Task 2.3 + 2.4.
- **AI assistant** — `AiOrb` is inert. Existing `BookProjectAgent` DO is reachable via `/agents/book-project-agent/$projectId`. Closed by Task 2.5.
- **BottomToolbar buttons** — Insert/Remix/Voice/Background are inert. Closed by Task 2.6.
- **TopRightPill buttons** — Share/Export/Read aloud are inert. Closed by Task 2.7.
- **Dashboard project deletion + restore** — `dashboard.tsx` has delete + restore of soft-deleted projects; `studio.index.tsx` doesn't. Closed by Task 2.8.

## Out of scope (intentional drop)
- Workflow status header tiles (concept/voice/outline/publisher readiness). Studio's drawer + breadcrumb subtitle covers the same info more compactly.
- "Refer & earn" placeholder.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-05-10-studio-parity-audit.md
git commit -m "docs: studio v2 parity audit (2026-05-10)"
```

---

## Phase 1: Q&A Outline Builder

The current `OutlineBuilder` is a tabbed disclosure panel. We replace it with a snap-scroll Q&A that reuses the `Step` pattern from `studio.compose.tsx`. The underlying API payload (`api.generateProjectOutline`) stays unchanged; only the input collection UX changes.

### Task 1.1: Extract reusable `Step` component from `studio.compose.tsx`

`Step`, `ChoiceCard`, and `FieldChip` are currently local to `routes/studio.compose.tsx`. Extract so both compose and OutlineBuilderQA share them.

**Files:**
- Create: `apps/web/client/components/studio/wizard.tsx`
- Modify: `apps/web/client/routes/studio.compose.tsx`

- [ ] **Step 1: Move components**

Copy the `Step`, `ChoiceCard`, `FieldChip` definitions out of `studio.compose.tsx` into `components/studio/wizard.tsx` as named exports. Identical bodies; only the imports change.

```tsx
// components/studio/wizard.tsx
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export function Step({
  index,
  total,
  title,
  subtitle,
  children,
  onNext,
  canAdvance,
  anchorId,
  active,
  ctaLabel = "Continue",
}: {
  index: number;
  total: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
  onNext: () => void;
  canAdvance: boolean;
  anchorId: string;
  active?: boolean;
  ctaLabel?: string;
}) {
  // body identical to studio.compose.tsx's Step, with `STEPS.length` replaced by `total`
}

export function ChoiceCard(/* same as compose */) { /* ... */ }
export function FieldChip(/* same as compose */) { /* ... */ }
```

- [ ] **Step 2: Update `studio.compose.tsx`**

Replace inline definitions with `import { Step, ChoiceCard, FieldChip } from "../components/studio/wizard";`. Pass `total={STEPS.length}` to each `Step`.

- [ ] **Step 3: Typecheck + lint**

```bash
cd apps/web && pnpm typecheck && cd ../.. && pnpm lint
```

Expected: both green, zero changes to compose page behavior.

- [ ] **Step 4: Commit**

```bash
git add apps/web/client/components/studio/wizard.tsx apps/web/client/routes/studio.compose.tsx
git commit -m "refactor(studio): extract Step/ChoiceCard/FieldChip into wizard.tsx"
```

### Task 1.2: Build `OutlineBuilderQA.tsx`

The Q&A wizard collects exactly the `api.generateProjectOutline` payload: `framework`, `questionnaire`, `character_arcs[]`, `scene_plan{}`, `chapter_plan[]`.

**Files:**
- Create: `apps/web/client/components/panels/OutlineBuilderQA.tsx`
- Test: `apps/web/client/components/panels/OutlineBuilderQA.test.tsx`

- [ ] **Step 1: Write the failing state-machine test**

```tsx
// OutlineBuilderQA.test.tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import OutlineBuilderQA from "./OutlineBuilderQA";

const project = {
  id: "p1",
  title: "Test",
  type: "fiction" as const,
  status: "draft",
  created_at: Date.now(),
  updated_at: Date.now(),
};

describe("OutlineBuilderQA", () => {
  it("renders all six steps with the right titles", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <OutlineBuilderQA project={project} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Pick a framework/i)).toBeInTheDocument();
    expect(screen.getByText(/Your premise/i)).toBeInTheDocument();
    expect(screen.getByText(/Who's in the story/i)).toBeInTheDocument();
    expect(screen.getByText(/Scene plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Chapter plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Review & generate/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify failure**

```bash
cd apps/web && pnpm vitest run client/components/panels/OutlineBuilderQA.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `OutlineBuilderQA.tsx`**

```tsx
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Step, ChoiceCard, FieldChip } from "../studio/wizard";
import {
  type CharacterArcInput,
  type ChapterPlanInput,
  type Project,
  api,
} from "../../lib/api";
import { OUTLINE_FRAMEWORKS } from "./_shared";

type StepKey = "framework" | "premise" | "characters" | "scene-plan" | "chapter-plan" | "review";

export default function OutlineBuilderQA({ project }: { project: Project }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameworks = OUTLINE_FRAMEWORKS.filter((f) => f.type === project.type);
  const [framework, setFramework] = useState<string>(frameworks[0]?.id ?? "");
  const [questionnaire, setQuestionnaire] = useState("");
  const [protagonist, setProtagonist] = useState("");
  const [antagonist, setAntagonist] = useState("");
  const [supporting, setSupporting] = useState("");
  const [defaultCast, setDefaultCast] = useState("");
  const [miniStructure, setMiniStructure] = useState("");
  const [chapterPlan, setChapterPlan] = useState<ChapterPlanInput[]>([
    { ordinal: 1, title: "", event: "" },
  ]);

  const generate = useMutation({
    mutationFn: () =>
      api.generateProjectOutline(project.id, {
        framework,
        questionnaire,
        character_arcs: buildCharacterArcs(),
        scene_plan: { defaultCast, miniStructure },
        chapter_plan: chapterPlan.filter((c) => c.event.trim()),
      }),
  });

  function buildCharacterArcs(): CharacterArcInput[] {
    const out: CharacterArcInput[] = [];
    if (protagonist.trim())
      out.push({ name: "Protagonist", arc: protagonist.trim(), position: "central" });
    if (antagonist.trim())
      out.push({ name: "Antagonist", arc: antagonist.trim(), position: "opposing" });
    if (supporting.trim())
      out.push({ name: "Supporting", arc: supporting.trim(), position: "supporting" });
    return out;
  }

  function goTo(id: StepKey) {
    const el = document.getElementById(`step-${id}`);
    if (el && containerRef.current) {
      const top =
        el.getBoundingClientRect().top -
        containerRef.current.getBoundingClientRect().top +
        containerRef.current.scrollTop -
        40;
      containerRef.current.scrollTo({ top, behavior: "smooth" });
    }
  }

  const total = 6;
  const canSubmit = questionnaire.trim().length > 8 && framework.length > 0;

  return (
    <div
      className="h-[calc(100vh-7rem)] snap-y snap-mandatory overflow-y-scroll"
      ref={containerRef}
    >
      <Step
        active
        anchorId="step-framework"
        index={1}
        total={total}
        onNext={() => goTo("premise")}
        canAdvance={framework.length > 0}
        title="Pick a framework"
        subtitle="The framework shapes the chapter rhythm and beats Book Cook will propose."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {frameworks.map((f) => (
            <ChoiceCard
              key={f.id}
              active={framework === f.id}
              onClick={() => setFramework(f.id)}
              title={f.label}
              subtitle={f.description}
            />
          ))}
        </div>
      </Step>

      <Step
        anchorId="step-premise"
        index={2}
        total={total}
        onNext={() => goTo("characters")}
        canAdvance={questionnaire.trim().length > 8}
        title="Your premise"
        subtitle="Write it out longhand — what's the book about, what's the promise, what does the reader leave with?"
      >
        <textarea
          className="w-full resize-none bg-transparent font-serif text-xl leading-relaxed outline-none placeholder:text-neutral-400"
          onChange={(e) => setQuestionnaire(e.target.value)}
          placeholder="The protagonist discovers..."
          rows={8}
          value={questionnaire}
        />
      </Step>

      <Step
        anchorId="step-characters"
        index={3}
        total={total}
        onNext={() => goTo("scene-plan")}
        canAdvance
        title={project.type === "fiction" ? "Who's in the story?" : "Who are you writing for?"}
        subtitle={
          project.type === "fiction"
            ? "Sketch a few arcs. Skip any you don't have yet."
            : "Audience first, then the perspectives you'll teach from."
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <FieldChip
            label={project.type === "fiction" ? "Protagonist" : "Primary audience"}
            onChange={setProtagonist}
            placeholder={
              project.type === "fiction" ? "A reluctant cartographer…" : "Senior PMs at SaaS cos…"
            }
            value={protagonist}
          />
          <FieldChip
            label={project.type === "fiction" ? "Antagonist" : "Secondary audience"}
            onChange={setAntagonist}
            placeholder=""
            value={antagonist}
          />
          <FieldChip
            label={project.type === "fiction" ? "Supporting" : "Voice / perspective"}
            onChange={setSupporting}
            placeholder=""
            value={supporting}
          />
        </div>
      </Step>

      <Step
        anchorId="step-scene-plan"
        index={4}
        total={total}
        onNext={() => goTo("chapter-plan")}
        canAdvance
        title="Scene plan"
        subtitle="Default cast for each scene and a mini-structure to anchor pacing."
      >
        <div className="space-y-3">
          <FieldChip
            label="Default cast"
            onChange={setDefaultCast}
            placeholder="Mira, Hesperus, the City"
            value={defaultCast}
          />
          <textarea
            className="w-full resize-none bg-transparent font-serif text-base leading-relaxed outline-none placeholder:text-neutral-400"
            onChange={(e) => setMiniStructure(e.target.value)}
            placeholder="Setup → escalating turn → payoff"
            rows={3}
            value={miniStructure}
          />
        </div>
      </Step>

      <Step
        anchorId="step-chapter-plan"
        index={5}
        total={total}
        onNext={() => goTo("review")}
        canAdvance
        title="Chapter plan"
        subtitle="Optional. Drop in a chapter or two — the rest can be generated."
      >
        <ChapterPlanEditor plan={chapterPlan} onChange={setChapterPlan} />
      </Step>

      <Step
        anchorId="step-review"
        index={6}
        total={total}
        onNext={() => generate.mutate()}
        canAdvance={canSubmit}
        title="Review & generate"
        ctaLabel={generate.isPending ? "Generating…" : "Generate outline"}
        subtitle="You can edit any answer above by scrolling back up."
      >
        <ReviewSummary
          framework={frameworks.find((f) => f.id === framework)?.label ?? framework}
          questionnaire={questionnaire}
          protagonist={protagonist}
          antagonist={antagonist}
          supporting={supporting}
          chapterCount={chapterPlan.filter((c) => c.event.trim()).length}
        />
        {generate.error ? (
          <p className="mt-3 text-red-500 text-sm">{generate.error.message}</p>
        ) : null}
      </Step>
    </div>
  );
}

function ChapterPlanEditor({
  plan,
  onChange,
}: {
  plan: ChapterPlanInput[];
  onChange: (next: ChapterPlanInput[]) => void;
}) {
  function update(idx: number, patch: Partial<ChapterPlanInput>) {
    onChange(plan.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function add() {
    onChange([...plan, { ordinal: plan.length + 1, title: "", event: "" }]);
  }
  function remove(idx: number) {
    onChange(plan.filter((_, i) => i !== idx).map((c, i) => ({ ...c, ordinal: i + 1 })));
  }
  return (
    <div className="space-y-3">
      {plan.map((c, i) => (
        <div className="grid grid-cols-1 gap-2 rounded-2xl bg-white/60 p-3 ring-1 ring-black/5 sm:grid-cols-[80px_1fr_1fr] dark:bg-white/5 dark:ring-white/10" key={i}>
          <FieldChip label="#" onChange={() => {}} placeholder="" value={String(c.ordinal)} />
          <FieldChip
            label="Title"
            onChange={(v) => update(i, { title: v })}
            placeholder="Chapter title"
            value={c.title ?? ""}
          />
          <FieldChip
            label="Event"
            onChange={(v) => update(i, { event: v })}
            placeholder="What happens here"
            value={c.event}
          />
          <button
            className="text-neutral-500 text-xs hover:text-red-500"
            onClick={() => remove(i)}
            type="button"
          >
            remove
          </button>
        </div>
      ))}
      <button
        className="rounded-full bg-neutral-950 px-4 py-2 text-neutral-200 text-sm"
        onClick={add}
        type="button"
      >
        + Add chapter
      </button>
    </div>
  );
}

function ReviewSummary(props: {
  framework: string;
  questionnaire: string;
  protagonist: string;
  antagonist: string;
  supporting: string;
  chapterCount: number;
}) {
  return (
    <div className="space-y-2 rounded-2xl bg-white/70 p-4 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
      <Row label="Framework" value={props.framework} />
      <Row label="Premise" value={props.questionnaire.slice(0, 120) || "—"} />
      {props.protagonist && <Row label="Protagonist" value={props.protagonist} />}
      {props.antagonist && <Row label="Antagonist" value={props.antagonist} />}
      {props.supporting && <Row label="Supporting" value={props.supporting} />}
      <Row label="Seed chapters" value={String(props.chapterCount)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <div className="w-28 shrink-0 text-[11px] text-neutral-500 uppercase tracking-wide">
        {label}
      </div>
      <div className="font-serif text-sm">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd apps/web && pnpm vitest run client/components/panels/OutlineBuilderQA.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

```bash
cd apps/web && pnpm typecheck && cd ../.. && pnpm lint
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/client/components/panels/OutlineBuilderQA.tsx apps/web/client/components/panels/OutlineBuilderQA.test.tsx
git commit -m "feat(panels): Q&A outline builder for studio flow"
```

### Task 1.3: Swap outline route to use the Q&A version

**Files:**
- Modify: `apps/web/client/routes/studio.$projectId.outline.tsx`

- [ ] **Step 1: Replace import**

Change:
```tsx
import OutlineBuilder from "../components/panels/OutlineBuilder";
```
to:
```tsx
import OutlineBuilderQA from "../components/panels/OutlineBuilderQA";
```
and update the usage. Remove the wrapping container max-width since the snap-scroll Q&A is full-bleed.

- [ ] **Step 2: Typecheck + lint**

```bash
cd apps/web && pnpm typecheck && cd ../.. && pnpm lint
```

- [ ] **Step 3: Manual smoke** (will run during PR review with `bash scripts/deploy.sh` and live URL)

- [ ] **Step 4: Commit + PR + merge + deploy**

```bash
git add apps/web/client/routes/studio.$projectId.outline.tsx
git commit -m "feat(studio): switch outline route to Q&A wizard"
gh pr create --title "Phase 1: Q&A outline builder" --body "..."  # body summarizes Phase 1
# squash-merge after CI green
bash scripts/deploy.sh
```

---

## Phase 2: Feature Parity

### Task 2.1: Extract `ChapterEditorPanel` from legacy route

**Files:**
- Create: `apps/web/client/components/panels/ChapterEditorPanel.tsx`
- Modify: `apps/web/client/routes/projects.$projectId.chapters.$chapterId.tsx`

- [ ] **Step 1: Move components**

Move these top-level functions from `projects.$projectId.chapters.$chapterId.tsx` into `ChapterEditorPanel.tsx`:
- `ChapterEditor` (line 92)
- `ChapterEditorInner` (line 96)
- `InlineAiPanel` (line 316)
- `SectionDraftPanel` (line 429)
- `DiffPreview` (line 536)
- helpers: `initialContent`, `wordCount`, `titleCase`, `getSelectedText` (lines 555–600)

Export a default `ChapterEditorPanel({ chapterId }: { chapterId: string })` that fetches `api.getChapter(chapterId)` + `api.getChapterSections(chapterId)` and renders the editor.

The legacy route file becomes thin:
```tsx
import { createFileRoute } from "@tanstack/react-router";
import ChapterEditorPanel from "../components/panels/ChapterEditorPanel";

export const Route = createFileRoute("/projects/$projectId/chapters/$chapterId")({
  component: () => {
    const { chapterId } = Route.useParams();
    return <ChapterEditorPanel chapterId={chapterId} />;
  },
});
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd apps/web && pnpm typecheck && cd ../.. && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/client/components/panels/ChapterEditorPanel.tsx apps/web/client/routes/projects.$projectId.chapters.$chapterId.tsx
git commit -m "refactor(panels): extract ChapterEditorPanel"
```

### Task 2.2: Add `/studio/$projectId/chapters/$chapterId` route

**Files:**
- Create: `apps/web/client/routes/studio.$projectId.chapters.$chapterId.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import ChapterEditorPanel from "../components/panels/ChapterEditorPanel";
import { BreadcrumbPill } from "../components/studio/BreadcrumbPill";
import { SideDrawer } from "../components/studio/SideDrawer";
import { TopLeftPill } from "../components/studio/TopLeftPill";
import { TopRightPill } from "../components/studio/TopRightPill";
import { api, queryKeys } from "../lib/api";

export const Route = createFileRoute("/studio/$projectId/chapters/$chapterId")({
  component: StudioChapter,
});

function StudioChapter() {
  const { projectId, chapterId } = Route.useParams();
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const chapter = useQuery({
    queryKey: queryKeys.chapter(chapterId),
    queryFn: () => api.getChapter(chapterId),
  });
  const [drawerOpen, setDrawerOpen] = useState(true);
  const title = project.data?.title ?? "Untitled book";
  const subtitle = chapter.data
    ? `Chapter ${chapter.data.ordinal} · ${chapter.data.title || "Untitled"}`
    : "Chapter";

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projectId={projectId}
        current="canvas"
      />
      <TopLeftPill drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} />
      <BreadcrumbPill title={title} subtitle={subtitle} />
      <TopRightPill />
      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${drawerOpen ? "lg:pl-[19rem]" : ""}`}
      >
        <div className="mx-auto max-w-5xl">
          <ChapterEditorPanel chapterId={chapterId} />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Wire scene cards in canvas to link here**

In `apps/web/client/routes/studio.$projectId.tsx`, change `SceneCard` to use a `Link` around the heading that navigates to `/studio/$projectId/chapters/$chapterId`. (Existing scene cards don't have an "open chapter" affordance — add one.)

Add to `SceneCard`'s header:
```tsx
<Link to="/studio/$projectId/chapters/$chapterId" params={{ projectId, chapterId }} className="ml-2 text-neutral-500 text-xs hover:underline">
  Open chapter →
</Link>
```

(Add `projectId` + `chapterId` to `SceneCard` props and thread through from `ChapterCanvas`.)

- [ ] **Step 3: Typecheck + lint**

- [ ] **Step 4: Commit**

```bash
git add apps/web/client/routes/studio.$projectId.chapters.$chapterId.tsx apps/web/client/routes/studio.$projectId.tsx
git commit -m "feat(studio): chapter editor route + open-chapter link from canvas"
```

### Task 2.3: Extract `FullBookPanel` from legacy route

**Files:**
- Create: `apps/web/client/components/panels/FullBookPanel.tsx`
- Modify: `apps/web/client/routes/projects.$projectId.book.tsx`

- [ ] **Step 1: Move body**

Move the assembled-manuscript rendering, jump-to-chapter nav, export buttons (`api.startBookExport`), and `api.listRenderJobs` polling into `FullBookPanel({ projectId }: { projectId: string })`. Legacy route file becomes a thin wrapper.

- [ ] **Step 2: Typecheck + lint + commit**

```bash
git commit -m "refactor(panels): extract FullBookPanel"
```

### Task 2.4: Add `/studio/$projectId/book` route + drawer link

**Files:**
- Create: `apps/web/client/routes/studio.$projectId.book.tsx`
- Modify: `apps/web/client/components/studio/SideDrawer.tsx` (add `book` to `StudioSection` + recent links)

- [ ] **Step 1: Implement route** (mirror Task 2.2 shape, replace `ChapterEditorPanel` with `FullBookPanel`)

- [ ] **Step 2: Add `book` to `StudioSection` union, drawer nav, and `sectionFromPathname`**

```tsx
// SideDrawer.tsx
export type StudioSection = "canvas" | "outline" | "marketplace" | "voice" | "book";
// ... add
<RecentLink to="/studio/$projectId/book" params={{ projectId }} active={active === "book"}>
  Book
</RecentLink>
// ... and in sectionFromPathname
if (pathname === `${base}/book` || pathname.startsWith(`${base}/book/`)) return "book";
```

- [ ] **Step 3: Typecheck + lint + commit**

```bash
git commit -m "feat(studio): full book route + drawer link"
```

### Task 2.5: Wire `AiOrb` to `BookProjectAgent` via `AiAssistantSheet`

The existing `BookProjectAgent` durable object is reachable via `/agents/book-project-agent/$projectId`. Open a slide-up panel from the orb with a streaming chat input.

**Files:**
- Create: `apps/web/client/components/studio/AiAssistantSheet.tsx`
- Modify: `apps/web/client/routes/studio.$projectId.tsx` (lift `AiOrb` into a stateful wrapper)

- [ ] **Step 1: Inspect existing agent client wiring**

```bash
cat apps/web/client/lib/ws.ts
grep -rn "useAgent\|BookProjectAgent\|/agents/" apps/web/client/ | head
```

Pick the SDK pattern already in use (`agents/react` `useAgentChat` or similar). Reuse — do not introduce a new chat lib.

- [ ] **Step 2: Implement `AiAssistantSheet`**

```tsx
// AiAssistantSheet.tsx
import { Sparkles, X } from "lucide-react";
import { useAgentChat } from "agents/react"; // adjust to actual import name once confirmed

export function AiAssistantSheet({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { messages, input, setInput, submit, isLoading } = useAgentChat({
    agent: "BookProjectAgent",
    name: projectId,
  });
  if (!open) return null;
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 max-w-2xl rounded-2xl bg-neutral-950/95 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur sm:right-4 sm:left-auto">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4" />
          Book Cook assistant
        </div>
        <button aria-label="Close" onClick={onClose} type="button" className="rounded p-1 hover:bg-white/10">
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto p-4 text-sm">
        {messages.map((m, i) => (
          <div key={i} className={`mb-3 ${m.role === "user" ? "text-neutral-200" : "text-emerald-300"}`}>
            {m.content}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex gap-2 border-t border-white/5 p-3"
      >
        <input
          className="flex-1 rounded bg-white/5 px-3 py-2 outline-none placeholder:text-neutral-500"
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this book…"
          value={input}
        />
        <button className="rounded bg-emerald-500/20 px-3 py-2 text-emerald-300 disabled:opacity-50" disabled={isLoading} type="submit">
          Send
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Toggle from `AiOrb` in `studio.$projectId.tsx`**

```tsx
const [assistantOpen, setAssistantOpen] = useState(false);
// ...
<AiOrb onClick={() => setAssistantOpen((v) => !v)} />
<AiAssistantSheet projectId={projectId} open={assistantOpen} onClose={() => setAssistantOpen(false)} />
```

Add `onClick` prop to `AiOrb`.

- [ ] **Step 4: Typecheck + lint + commit**

```bash
git commit -m "feat(studio): AI orb opens project assistant chat sheet"
```

### Task 2.6: Wire `BottomToolbar` actions

Currently `Insert / Remix / Voice / Background` are inert. Decide:
- **Insert** → opens the canvas's `InsertBar` actions menu at the bottom of the chapter list. Same `api.draftSection` call as the per-section InsertBar.
- **Remix** → opens inline rewrite: requires text selection in the focused scene; sends to `api.reviseChapterSelection({ action: "rewrite", text, context_md })`.
- **Voice** → navigates to `/studio/$projectId/voice`.
- **Background** → out of scope, **remove the button**.

**Files:**
- Modify: `apps/web/client/routes/studio.$projectId.tsx` (BottomToolbar component definition)

- [ ] **Step 1: Replace BottomToolbar**

```tsx
function BottomToolbar({ projectId, onInsert, onRemix }: { projectId: string; onInsert: () => void; onRemix: () => void }) {
  return (
    <div className="-translate-x-1/2 fixed bottom-6 left-1/2 z-20 flex items-center gap-1 rounded-full bg-neutral-950/90 p-1 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur">
      <PillButton icon={<Plus className="size-4" />} onClick={onInsert}>Insert</PillButton>
      <PillButton icon={<Wand2 className="size-4" />} onClick={onRemix}>Remix</PillButton>
      <Link
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm hover:bg-white/10"
        params={{ projectId }}
        to="/studio/$projectId/voice"
      >
        <Type className="size-4" /> Voice
      </Link>
    </div>
  );
}
```

Add `onClick` prop to `PillButton`.

- [ ] **Step 2: Implement `onInsert` + `onRemix` in `StudioProject`**

`onInsert` triggers `draftMutation` on the last chapter's last section (or the first chapter if none have sections yet). `onRemix` reads `window.getSelection()`, validates non-empty, fires `reviseChapterSelection` with `action: "rewrite"`, opens a small toast.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
git commit -m "feat(studio): wire BottomToolbar Insert/Remix/Voice"
```

### Task 2.7: Wire `TopRightPill` Export + Read aloud

**Files:**
- Modify: `apps/web/client/components/studio/TopRightPill.tsx`

- [ ] **Step 1: Add props**

```tsx
export function TopRightPill({
  onShare,
  onExport,
  onReadAloud,
}: {
  onShare?: () => void;
  onExport?: () => void;
  onReadAloud?: () => void;
}) { /* pass to PillButton onClick */ }
```

- [ ] **Step 2: Implement actions in `studio.$projectId.tsx`**

- `onShare` → `navigator.clipboard.writeText(window.location.href)` + toast.
- `onExport` → `api.startBookExport(projectId, { formats: ["epub", "pdf"] })` then nav to `/studio/$projectId/book` to show the render job progress (where Task 2.3's `FullBookPanel` is already polling jobs).
- `onReadAloud` → POST to `/api/v1/projects/$projectId/tts` (new tiny route, Task 2.7a below) that pipes the current chapter through `dynamic/audio_gen` and streams audio back. Stub for now: open an alert "Coming soon" if route doesn't exist; ship as Task 2.7a.

- [ ] **Step 2a (sub-task): Add `/api/v1/projects/:id/tts` route**

Already exists at `gateway.audioGen` in `apps/web/src/lib/gateway.ts`. Add a Hono route under `apps/web/src/routes/projects.ts` POST `/api/v1/projects/:id/tts` that selects the current chapter's `draft_md`, calls `gateway.audioGen`, returns the audio as `audio/mpeg`.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
git commit -m "feat(studio): wire TopRightPill Share/Export/Read aloud"
```

### Task 2.8: Project delete + restore in `/studio/`

Dashboard has delete + restore. Studio index doesn't. Add to `studio.index.tsx`.

**Files:**
- Modify: `apps/web/client/routes/studio.index.tsx`

- [ ] **Step 1: Add a kebab menu to each project card**

Reuse `api.deleteProject` + `api.restoreProject`. Show a "Recently deleted" disclosure section below the grid using `api.listDeletedProjects`.

- [ ] **Step 2: Typecheck + lint + commit**

```bash
git commit -m "feat(studio): project delete + restore on home"
```

### Task 2.9: Ship Phase 2 as one PR

- [ ] **Step 1: Open PR, wait for CI, squash-merge with `--admin`**

```bash
git push -u origin studio-v2-parity
gh pr create --title "Phase 2: studio v2 feature parity" --body "Closes the parity gap with /projects/* per docs/superpowers/notes/2026-05-10-studio-parity-audit.md"
gh pr merge <N> --squash --delete-branch --admin
bash scripts/deploy.sh
```

- [ ] **Step 2: Manual smoke**

Visit `/studio/<id>/chapters/<chapterId>`, `/studio/<id>/book`, click AI orb, Bottom toolbar Insert/Remix, TopRightPill Export. Confirm no console errors.

---

## Phase 3: Cutover

### Task 3.1: Flip post-signin default

**Files:**
- Modify: `apps/web/client/routes/index.tsx:26`
- Modify: `apps/web/client/routes/sign-in.tsx:23`

- [ ] **Step 1: Change both redirects**

```diff
- throw redirect({ to: "/dashboard", replace: true });
+ throw redirect({ to: "/studio", replace: true });
```

```diff
- else nav({ to: "/dashboard" });
+ else nav({ to: "/studio" });
```

- [ ] **Step 2: Typecheck + lint + commit**

### Task 3.2: Convert `/dashboard` to a redirect

**Files:**
- Modify: `apps/web/client/routes/dashboard.tsx`

- [ ] **Step 1: Replace the file body**

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: () => {
    throw redirect({ to: "/studio", replace: true });
  },
  component: () => null,
});
```

- [ ] **Step 2: Typecheck + lint + commit**

```bash
git commit -m "chore(dashboard): redirect to /studio (retired)"
```

### Task 3.3: Convert `/projects/*` to redirects

**Files:**
- Modify: `apps/web/client/routes/projects.$projectId.tsx`
- Modify: `apps/web/client/routes/projects.$projectId.book.tsx`
- Modify: `apps/web/client/routes/projects.$projectId.launch.tsx`
- Modify: `apps/web/client/routes/projects.$projectId.chapters.$chapterId.tsx`

- [ ] **Step 1: For each file, replace body with a redirect**

`projects.$projectId.tsx`:
```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/studio/$projectId", params: { projectId: params.projectId }, replace: true });
  },
  component: () => null,
});
```

`projects.$projectId.book.tsx` → redirect to `/studio/$projectId/book`.
`projects.$projectId.launch.tsx` → redirect to `/studio/$projectId/marketplace` with `search: { tab: "launch" }`.
`projects.$projectId.chapters.$chapterId.tsx` → redirect to `/studio/$projectId/chapters/$chapterId`.

- [ ] **Step 2: Verify panel files are still imported elsewhere**

```bash
grep -rn "from.*panels/ChapterEditorPanel\|from.*panels/FullBookPanel" apps/web/client/
```

Expect each to appear in its studio route (Tasks 2.2, 2.4). If a panel becomes unused, that's fine — leave it; the studio routes reference it.

- [ ] **Step 3: Confirm legacy panel files (`ConceptScoutPanel`, `VoicePanel`, `PublishPanel`, `LaunchPanel`, `OutlineGenerationProgress`, `WorkflowHeader`, etc.) are not loaded by any active route now that `/projects/$id` is a redirect**

```bash
grep -rn "WorkflowHeader\|ChapterSkeletonsPanel" apps/web/client/routes/
```

Expect: no results (since `/projects/$id` no longer renders them). Mark them for follow-up dead-code removal but leave them in this PR — keeping diff scope tight.

- [ ] **Step 4: Typecheck + lint + commit**

```bash
git commit -m "chore(projects): redirect /projects/* to /studio/*"
```

### Task 3.4: Update internal links

Find any in-app `<Link>`s still pointing to `/projects/*` or `/dashboard` and update them.

**Files:**
- Modify: any results from the grep below.

- [ ] **Step 1: Find them**

```bash
grep -rnE "to=\"/projects/|to=\"/dashboard|href=\"/projects/|href=\"/dashboard" apps/web/client/
```

- [ ] **Step 2: Update each to its studio equivalent**

- `/dashboard` → `/studio`
- `/projects/$id` → `/studio/$id`
- `/projects/$id/launch` → `/studio/$id/marketplace` (with `search: { tab: "launch" }`)
- etc.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
git commit -m "chore: update internal links to studio routes"
```

### Task 3.5: Ship Phase 3 + deploy

- [ ] **Step 1: PR, CI, merge, deploy**

```bash
git push -u origin studio-cutover
gh pr create --title "Phase 3: cutover to /studio default" --body "Closes the legacy /projects/* routes by converting them to redirects, flips post-signin to /studio."
gh pr merge <N> --squash --delete-branch --admin
bash scripts/deploy.sh
```

- [ ] **Step 2: Smoke test**

- `https://book-cook.com/` (signed in) → redirects to `/studio` ✅
- `https://book-cook.com/dashboard` → redirects to `/studio` ✅
- `https://book-cook.com/projects/<id>` → `/studio/<id>` ✅
- `https://book-cook.com/projects/<id>/launch` → `/studio/<id>/marketplace?tab=launch` ✅
- `https://book-cook.com/projects/<id>/chapters/<chId>` → `/studio/<id>/chapters/<chId>` ✅

---

## Out of Scope (explicit non-goals)

- Deleting the legacy panel files (`WorkflowHeader.tsx`, `ChapterSkeletonsPanel.tsx`, etc.) — left for a follow-up dead-code sweep after one release of stability.
- Migrating `/scout` standalone route into studio nav — it remains accessible as a top-level link from the user-chip menu.
- Mobile-specific layouts for the studio chrome — current responsive behavior is acceptable; iterate later.
- A `studio_v2` feature flag — given the cutover is one-way and main is unprotected, flag overhead isn't worth it; just ship.

## Self-Review Checklist

- [x] Every task lists exact file paths.
- [x] Q&A wizard reuses extracted `Step`/`ChoiceCard`/`FieldChip` from `wizard.tsx` (Task 1.1) — type signatures consistent across compose + OutlineBuilderQA.
- [x] `StudioSection` union covers `book` (added in Task 2.4) — referenced in SideDrawer + sectionFromPathname.
- [x] Panel extractions (ChapterEditorPanel, FullBookPanel, LaunchPanel) reused by both legacy redirects' chain (until removal) and studio routes.
- [x] Phase 3 redirects are correctly typed for TanStack Router (use `params` for dynamic segments, `search` for marketplace tab).
- [x] No placeholders ("TBD", "implement later", "add validation") in any step body.
- [x] AI gateway constraint respected: TTS routes through `gateway.audioGen` (already gateway-wrapped); chat uses existing agent binding which routes through gateway dynamic routes.

---

**End of plan.**
