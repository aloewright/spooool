# Prompt-to-Video Agent Architecture (sub-project #4)

**Status:** Approved design, ready for implementation plan
**Date:** 2026-05-27
**Scope:** Sub-project #4 of the recorder + render pipeline: an "agent-driven" creation flow at `/create` that turns a user prompt (plus optional Q&A) into a finished animated explainer video, using Cloudflare's AI Gateway + Managed Agents + Agents SDK + the existing render pipeline.

## Context

Sub-project #1 ([`2026-05-26-recorder-pipeline-design.md`](2026-05-26-recorder-pipeline-design.md)) shipped a deterministic record-and-render pipeline. The bigger initiative also planned three AI-driven sub-projects on top:
- #2 — Composer agent (replace fixed templates with agent-generated composition)
- #3 — Coach agent (real-time recording feedback)
- #4 — Text-to-video (this spec) — prompt → animated explainer with no recording

This spec covers #4 only. It does **not** depend on #2 or #3 (the original decomposition listed #4 as depending on #2, but on review the design produces its own composition spec directly, so #2 is no longer a prerequisite).

## Goals

1. User opens `/create`, types a prompt or walks through a craft-aware Q&A, and gets back a rendered MP4 in under ~3 minutes for the typical case.
2. Two creation modes available per-prompt:
   - **Auto** — fire-and-forget, Cloudflare Managed Agent (CMA) drives the toolchain.
   - **Guided** — wizard-style Q&A (same pattern as `book-cook.com/studio/compose`), backed by a Cloudflare Agents SDK Durable Object.
3. All LLM / TTS calls route through Cloudflare AI Gateway dynamic routes (per the `CLAUDE.md` rule — no direct provider SDKs).
4. The agent's final action invokes the **existing render pipeline** — same `render_jobs` table, same `RenderContainer`, same Remotion render path, same Stream handoff. The only new render artifact is a new Remotion composition (`spooool-explainer`).
5. Single template (`hero-journey`) ships in v1. Template registry is shaped for N templates so adding more later is purely additive.

## Non-goals

- Multiple templates in v1 (one is enough to validate the architecture).
- Text-to-video generative model integration (e.g., Veo / Sora). Scope is animated explainer / motion graphics with TTS narration.
- Visual upscaling, voice cloning, custom fonts per video.
- Composer agent (#2) or Coach agent (#3) — separate specs.
- Cross-domain SSO between spooool and the `editor` worker. We mirror its Q&A *style*; we do not share its storage.

## Approach

Dual-agent shape with a shared toolchain, layered on top of the existing render pipeline:

- **Auto mode** uses Cloudflare Managed Agents (CMA) — Anthropic's hosted agent runtime. CMA owns the loop: pick template, fill in answers, run tools. Returns when the render job is queued.
- **Guided mode** uses a Cloudflare Agents SDK Durable Object (one per session). The DO walks the user through the template's questions over a WebSocket, then runs the same toolchain.
- **Tools** are pure worker functions imported by both runtimes. They wrap AI Gateway `dynamic/*` endpoints and a final `submitRenderJob()` call into the existing pipeline.
- **Render** reuses sub-project #1's container, with a new Remotion composition (`spooool-explainer`) added to the existing `remotion/` tree in the container image.

Approach alternatives considered and rejected:
- **Single DO-backed agent with dual modes** — dropped CMA from the picture; loses the explicit benefit the user asked for ("use CMA and Agents SDK").
- **Plain Workflows (no agent loop)** — too rigid; no autonomy or clarifying questions.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (spooool React app — new /create page)                     │
│   Mode toggle: ⚡ Auto  ────────  🧭 Guided                          │
│                                                                    │
│   AutoMode:    [prompt textarea] → [Generate]                      │
│                  progress bar + status while CMA loop runs         │
│                                                                    │
│   GuidedMode:  wizard-style Q&A from the template's question list  │
│                "Generate video" button after the last answer       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼  REST + WebSocket
┌────────────────────────────────────────────────────────────────────┐
│ Worker — src/workers/create.ts                                     │
│   GET  /api/create/templates            list templates              │
│   GET  /api/create/templates/:id        full template with questions│
│   POST /api/create/auto                 start one-shot CMA job      │
│   POST /api/create/sessions             start guided DO session    │
│   GET  /api/create/sessions/:id         snapshot DO state          │
│   WS   /api/create/sessions/:id/stream  live Q&A + status          │
│   GET  /api/create/jobs/:id             terminal status (alias of  │
│                                         /api/render/jobs/:id)      │
└──────┬──────────────────────────────────┬──────────────────────────┘
       │ auto                              │ guided
       ▼                                   ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│ CMA (Cloudflare Claude   │    │ ComposerAgent DO                 │
│  Managed Agents)         │    │ (Cloudflare Agents SDK)          │
│                          │    │ holds Q&A state per session,     │
│ One-shot loop:           │    │ streams via WebSocket, runs the  │
│   draft_script           │    │ same toolset after Q&A complete  │
│   plan_scenes            │    │                                  │
│   synthesize_tts         │    │                                  │
│   finalize_render        │    │                                  │
└────────────┬─────────────┘    └──────────────┬───────────────────┘
             │                                  │
             └──────────────┬───────────────────┘
                            ▼
          ┌─────────────────────────────────────┐
          │ Shared tools (src/workers/create-tools.ts) │
          │  draft_script(answers, template)    │  → AI GW dynamic/text_gen
          │  plan_scenes(script, template)      │  → AI GW dynamic/text_gen
          │  synthesize_tts(script, voice)      │  → AI GW dynamic/audio_gen
          │                                     │    → R2 (recorder/tts/{jobId}.mp3)
          │  finalize_render(scenes, audioKey)  │  → submitRenderJob() (in-process)
          └─────────────────────────────────────┘
                            ▼
          ┌─────────────────────────────────────┐
          │ Existing render pipeline (sub-#1)   │
          │   render_jobs row                   │
          │   RenderContainer                   │
          │   Remotion: NEW comp                │
          │     `spooool-explainer`             │
          │   R2 + Stream → /watch/:videoId     │
          └─────────────────────────────────────┘
```

Per-account isolation: same per-user CF Container instance as sub-project #1 (`idFromName(user.id)`). A user's prompt-to-video render and a user's recorder render compete for the same container instance (3-slot queue cap shared across both).

## Components

### 1. Frontend — `/create` page

- New route in `src/frontend/App.tsx` next to `/record` and `/upload`. Gated on `useSession()` + `emailVerified`.
- New tree under `src/frontend/create/`:
  - `index.ts` exports `CreateRoot`
  - `App.tsx` — mode toggle + lazy-loads the selected mode
  - `AutoMode.tsx` — prompt textarea + progress polling (mirrors `RenderProgress` from sub-#1)
  - `GuidedMode.tsx` — wizard that walks template questions
  - `TemplatePicker.tsx` — single template visible in v1; shaped for N
  - `lib/create-client.ts` — typed REST/WebSocket calls (`createAutoJob`, `createSession`, `connectSessionStream`)
  - `lib/template.ts` — re-exports the canonical template types from `src/workers/create/templates/types.ts` so frontend and worker share one source of truth

### 2. Templates registry — `src/workers/create/templates/`

```ts
export interface Question {
  id: string;
  text: string;
  hint?: string;
  multiline?: boolean;
}

export interface ScenePlanHint {
  beatId: string;        // e.g., 'ordinary-world'
  questionIds: string[]; // which answers fuel this beat
  durationSeconds: number;
}

export interface StoryTemplate {
  id: string;
  name: string;
  description: string;
  questions: Question[];
  systemPromptFragment: string;
  scenePlan: ScenePlanHint[];
  voice: { profile: 'neutral' | 'warm' | 'energetic'; pacingWpm: number };
}

export const TEMPLATES: Record<string, StoryTemplate>;
export function getTemplate(id: string): StoryTemplate | null;
```

`hero-journey.ts` content mirrors the editor worker's question set (`What is the ordinary world?`, `What forces them out?`, `What is the lie they believe?`, etc.) adapted for ≤60-second scenes rather than chapters. Voice profile `warm`, pacingWpm 150.

### 3. Worker routes — `src/workers/create.ts`

Hono router mounted in `src/workers/index.ts`. Reuses the existing CSRF protection, rate-limit middleware, and session-extraction pattern.

| Method | Path | Auth | Body / behavior |
|---|---|---|---|
| GET | `/api/create/templates` | session | List template metadata (no question texts inlined). |
| GET | `/api/create/templates/:id` | session | Full template with questions. |
| POST | `/api/create/auto` | session + new `CREATE_BUCKET` rate-limit | `{ templateId, prompt }`. Insert `render_jobs` row, invoke CMA fire-and-forget via `ctx.waitUntil`, return `{ jobId }`. |
| POST | `/api/create/sessions` | session + `CREATE_BUCKET` | `{ templateId }`. Insert `create_sessions` row, get DO stub, prime with template. Return `{ sessionId, firstQuestion }`. |
| GET | `/api/create/sessions/:id` | session (owner-only) | Snapshot of current Q&A state for resume. |
| WS | `/api/create/sessions/:id/stream` | session (owner-only) | Bidirectional: `{ type: 'answer', answer }` from client; `{ type: 'question' \| 'status' \| 'render_started' \| 'error', ... }` from server. |
| GET | `/api/create/jobs/:id` | session (owner-only) | Alias of `/api/render/jobs/:id`. Provided so the frontend uses a consistent namespace. |

### 4. CMA wrapper — `src/workers/create-cma.ts`

Wraps the Cloudflare Managed Agents runtime:
- Tools registered: `draft_script`, `plan_scenes`, `synthesize_tts`, `finalize_render`.
- Tool calls go to the shared `create-tools.ts` implementations (direct function imports, not HTTP).
- LLM calls go through AI Gateway `dynamic/text_gen` (the CMA-managed Anthropic client is configured to route via the gateway).
- System prompt: "Given the user prompt and template, generate plausible Q&A answers, then run the toolchain to completion. Do not ask follow-up questions."

### 5. ComposerAgent Durable Object — `src/workers/composer-agent-do.ts`

Cloudflare Agents SDK class. One instance per session (`idFromName(sessionId)`).
- Persisted state shape: `{ userId, templateId, answers: Record<questionId, string>, currentQuestionIdx: number, status: 'questioning' \| 'rendering' \| 'completed' \| 'failed' \| 'abandoned', jobId?: string }`.
- WebSocket handler:
  - Receives `{ type: 'answer', answer }` → stores in `answers`, advances `currentQuestionIdx`, streams next question or `{ type: 'questions_complete' }`.
  - Receives `{ type: 'generate' }` → transitions to `rendering`, runs the toolchain (`draft_script` → `plan_scenes` → `synthesize_tts` → `finalize_render`), streams `{ type: 'status' }` updates per tool, ends with `{ type: 'render_started', jobId }`.
- Uses Agents SDK's built-in WebSocket fanout — multiple browser tabs can join a session and see consistent state.

### 6. Shared tool implementations — `src/workers/create-tools.ts`

Pure functions, deps injected for unit testing:

```ts
async function draftScript(args: { template: StoryTemplate; answers: Record<string,string>; env: AIGatewayEnv }): Promise<{ script: string }>;
async function planScenes(args: { script: string; template: StoryTemplate; env: AIGatewayEnv }): Promise<{ scenes: SceneSpec[] }>;
async function synthesizeTts(args: { script: string; voice: VoiceProfile; jobId: string; env: AIGatewayEnv & R2Env }): Promise<{ r2Key: string; durationMs: number }>;
async function finalizeRender(args: { jobId: string; userId: string; scenes: SceneSpec[]; ttsR2Key: string; env: RenderEnv }): Promise<void>;
```

Behaviors:
- `draft_script` — calls `dynamic/text_gen` with `template.systemPromptFragment` + the answers. Cap script to 1500 chars. Retry 2× on 5xx.
- `plan_scenes` — calls `dynamic/text_gen` with a stricter system prompt requesting JSON-only output. Validates against the SceneSpec schema. One re-prompt on bad JSON. Cap scenes to 20.
- `synthesize_tts` — calls `dynamic/audio_gen` with `script` + `voice.profile`. Streams returned mp3 bytes to R2 at `recorder/tts/{jobId}.mp3`. Returns `r2Key` + computed `durationMs`.
- `finalize_render` — calls `submitRenderJob({ userId, compositionId, compositionProps, env })` from `src/workers/render.ts`. **Refactor required:** the `POST /api/render/jobs` handler in sub-project #1 does its insert + container dispatch inline; this task extracts that logic into a `submitRenderJob()` exported function so the HTTP handler and `finalize_render` both call it. `compositionProps: { scenes, audio: { r2Key: ttsR2Key }, brand: { color: '#0a84ff' } }`. `submitRenderJob` updates `render_jobs.composition_spec` with the resolved spec.

### 7. Remotion composition — `container/render/remotion/SpoooolExplainer.tsx`

New composition registered in `container/render/remotion/Root.tsx` with `id: 'spooool-explainer'`. Input props:

```ts
{
  scenes: Array<{
    type: 'title' | 'beat' | 'outro';
    durationFrames: number;
    text: string;        // main on-screen text
    subtitle?: string;   // optional smaller text
  }>;
  audio: { r2Path: string }; // public/{jobId}/audio.mp3 (set by render harness)
  brand: { color?: string };
}
```

`calculateMetadata` returns `durationInFrames = sum(scenes[i].durationFrames)`. Composition renders sequences with simple typographic layouts (Inter font, brand color background, Lottie-free for v1).

The container's render harness (`container/render/src/render.ts`) gains a generalized `downloadAsset(key, dest)` that handles both recorder takes and TTS audio. The composition's `audio.r2Path` is set by the harness after the asset is downloaded (`public/{jobId}/audio.mp3`).

### 8. D1 schema additions — `src/db/migrations/0021_create_sessions.sql`

```sql
CREATE TABLE create_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('questioning','rendering','completed','failed','abandoned')),
  answers TEXT NOT NULL DEFAULT '{}',  -- JSON {questionId: answer}
  job_id TEXT,                          -- FK to render_jobs.id once finalized
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (job_id) REFERENCES render_jobs(id)
);
CREATE INDEX idx_create_sessions_user_status ON create_sessions(user_id, status);
CREATE INDEX idx_create_sessions_stuck ON create_sessions(status, updated_at);
```

Auto-mode does not create a `create_sessions` row — it writes directly to `render_jobs`. Guided-mode rows transition to `completed` (linked to `job_id`), `failed`, or `abandoned`.

### 9. Wrangler additions — `wrangler.toml`

```toml
# ComposerAgent DO (Agents SDK)
[[durable_objects.bindings]]
name = "COMPOSER_AGENT"
class_name = "ComposerAgent"

[[migrations]]
tag = "do_v4"
new_sqlite_classes = ["ComposerAgent"]

# CMA binding — exact binding name pending CMA SDK API (TBD verify against docs at build time)
[[ai]]
binding = "AI"
```

(The `[[ai]]` binding may already exist or be configured differently — verify before merging the wrangler change.)

## Data flow

### Auto mode

1. User opens `/create`, picks "Auto", types prompt, clicks **Generate**.
2. Frontend `POST /api/create/auto { templateId: 'hero-journey', prompt }`.
3. Worker:
   - Inserts `render_jobs` row with `status='queued'` and `composition_spec='{}'` (placeholder; `finalize_render` will write the resolved spec).
   - Invokes CMA via `ctx.waitUntil` so the request returns immediately with `{ jobId }`.
4. CMA loop runs:
   - `draft_script` (LLM auto-fills answers from the prompt) → 200-word script.
   - `plan_scenes` → `SceneSpec[]`.
   - `synthesize_tts` → R2 key + duration.
   - `finalize_render` → updates `render_jobs.composition_spec` with the resolved scenes + audio, dispatches the container.
5. Container renders `spooool-explainer`, uploads MP4 to R2, calls back `/complete`.
6. Existing `/complete` handler creates `videos` row, enqueues `VIDEO_ENCODING`, marks `render_jobs.status='completed'` with `video_id`.
7. Frontend polls `/api/create/jobs/:id` (alias of `/api/render/jobs/:id`) every 2s; on `completed` navigates to `/watch/{videoId}`.

### Guided mode

1. User opens `/create`, picks "Guided", picks template (hero-journey).
2. Frontend `POST /api/create/sessions { templateId: 'hero-journey' }`.
3. Worker inserts `create_sessions` row (`status='questioning'`), gets `ComposerAgent` DO stub, primes it with the template, returns `{ sessionId, firstQuestion }`.
4. Frontend opens WebSocket `/api/create/sessions/:id/stream`.
5. For each question: client sends `{ type: 'answer', answer }`, DO persists, streams next question; loops until `{ type: 'questions_complete' }`.
6. User clicks **Generate video** → client sends `{ type: 'generate' }`.
7. DO transitions to `rendering`, runs the same toolchain as auto mode, streaming `{ type: 'status', stage: 'drafting'|'planning'|'tts'|'rendering' }`.
8. After `finalize_render`, DO writes `create_sessions.job_id` and streams `{ type: 'render_started', jobId }`.
9. Client polls `/api/create/jobs/:id` (same as auto) until completion, navigates to `/watch/{videoId}`.

### Shared

- TTS audio stored at `recorder/tts/{jobId}.mp3` in the `spooool-videos` bucket. The `recorder-raw-7d` lifecycle rule (prefix `recorder/raw/`) does **not** cover it — add a second rule `recorder-tts-7d` with prefix `recorder/tts/` (manual ops setup).
- Render job tracking: same `render_jobs` table. No new render-state machine.
- Concurrency: shared per-user container queue cap (3 pending) across recorder and prompt-to-video.

## Error handling

| Layer | Failure | Behavior |
|---|---|---|
| AI Gateway | `dynamic/text_gen` 5xx or timeout | 2× retry, 500ms / 2s backoff. Final → `render_jobs.error_message = "Script generation failed: <provider>"`. |
| AI Gateway | `plan_scenes` returns invalid JSON | 1× re-prompt with stricter schema. Still bad → `Scene plan invalid`. |
| AI Gateway | `dynamic/audio_gen` non-audio body | 1× retry. Final → `TTS synthesis failed`. |
| AI Gateway | Content-policy refusal | Log actual reason server-side, surface generic "Generation failed, please try rephrasing your prompt." to user. Fail fast (no retry). |
| Worker | TTS upload to R2 fails | 3× exponential backoff. Final → fail the job. |
| Worker | `finalize_render` D1 insert fails | Existing `render_jobs` failure path (sub-#1). |
| CMA | Runtime error / network blip | Job stays `queued`. Existing 5-min `runStuckJobSweep` marks `failed` with `Agent timeout` at 15 min. |
| Composer DO | Crashes mid-session | Agents SDK persists state; client reconnect resumes from last unsent message. If `status='rendering'` and DO unreachable, new `runAbandonedSessionsSweep` marks `abandoned` after 30 min. |
| WebSocket | Drops mid-question | Client auto-reconnects with `sessionId`. DO replays last unsent message. |
| Container | Can't download `recorder/tts/{jobId}.mp3` | Posts `/fail` with `Missing TTS audio`. |
| Container | Remotion render error | Existing `/fail` path with stderr tail (sub-#1). |
| Frontend | Network errors during polling | Existing render-progress retry behaviour (sub-#1). |

### Cost / abuse guards

- New rate-limit bucket `CREATE_BUCKET` (e.g., 5 prompt-to-video requests per hour per user; configurable). Applied to both `/api/create/auto` and `/api/create/sessions`.
- Hard caps inside tools:
  - `draft_script` → script ≤ 1500 chars
  - `plan_scenes` → scenes ≤ 20
  - `synthesize_tts` → asserts script ≤ 2000 chars before calling `audio_gen`
- Cost telemetry: each tool logs `{ tokens, audioSeconds, estimatedCostUsd }` via `console.log` so we can chart spend in Workers Logs.

### New cron sweep
- Extend the existing `*/5 * * * *` cron handler to also run `runAbandonedSessionsSweep(env.DB)` — marks `create_sessions` rows with `status='questioning' AND updated_at < now - 24h` as `abandoned`.

## Testing

### Unit (CI)

| Target | File |
|---|---|
| `create-tools.ts` — each tool's happy path, retries, hard caps, content-policy masking | `src/workers/create-tools.test.ts` |
| `create.ts` routes — auth gates, owner-only, rate limits, validation | `src/workers/create.test.ts` |
| `composer-agent-do.ts` — state transitions, WebSocket message handling, persistence | `src/workers/composer-agent-do.test.ts` |
| Template registry — `hero-journey` shape integrity | `src/workers/create/templates/index.test.ts` |
| `SpoooolExplainer` composition — duration matches scenes, renders synthetic props | `container/render/remotion/SpoooolExplainer.test.tsx` |
| `GuidedMode` — walks questions, captures answers, sends generate | `src/frontend/create/GuidedMode.test.tsx` |
| `AutoMode` — submit → poll → navigate-on-complete | `src/frontend/create/AutoMode.test.tsx` |

Mocks: fake AI Gateway (canned responses keyed by route), in-memory R2 map, existing D1 stub pattern, scripted CMA shim.

### Integration (gated)

- `tests/e2e/create-flow.spec.ts` (Playwright, `E2E_RUN_CREATE=1`): walks the hero-journey wizard with deterministic answers, waits for `/watch/:videoId`.
- `scripts/smoke-create.mjs`: post-deploy API smoke — `POST /api/create/auto` with a fixed prompt, asserts a video lands within 10 min.

Both gated by env so normal CI doesn't burn AI Gateway credits.

### Manual smoke

Append a section to `docs/runbooks/recorder-smoke-test.md`:
- Auto mode happy path: prompt → MP4 in ≤2 min, voiceover in sync.
- Guided mode: full hero-journey wizard, video lands in user's library.
- Failure injection: empty prompt → 400; banned-content prompt → masked refusal; over-long prompt → 400.

### Out of scope for v1 tests
- Real AI Gateway calls in CI.
- Multi-template integration coverage.
- Load testing of CMA / DO concurrency.
- Render-quality regression (no visual diff yet).

## Open items to verify during implementation

1. **CMA wrangler binding shape** — confirm the exact `[[ai]]` / `[[managed_agents]]` block syntax against current CF docs before merging.
2. **AI Gateway TTS route** — verify `dynamic/audio_gen` returns mp3 binary (not just a URL) and exposes a `voice` parameter compatible with the upstream model.
3. **CMA tool import** — confirm CMA's tool registry can call worker-local functions directly rather than requiring HTTP-shaped tools. If not, expose the tools as `/internal/tools/*` routes authed by a shared secret (same pattern as the render callback).
4. **R2 lifecycle rule for `recorder/tts/`** — manual setup, mirroring the existing `recorder-raw-7d` rule.
5. **Per-user rate limit values** — start conservative (5/hr) and tune from observed spend.

## Manual ops setup (post-merge)

- [ ] `wrangler secret put` any new AI Gateway tokens if CMA requires its own.
- [ ] R2 lifecycle rule: prefix `recorder/tts/`, expire 7 days. Add via CF dashboard or `npx wrangler r2 bucket lifecycle add spooool-videos recorder-tts-7d recorder/tts/ --expire-days 7 --force`.
- [ ] If CMA binding requires it, register the Anthropic model + tool catalogue in the CF dashboard before first deploy.

## Out of scope for this spec

- AI agents #2 (composer) and #3 (coach) — separate specs.
- Generative video models (Veo/Sora/Kling) — animated explainer only in v1.
- Multi-template support — registry shape supports it but only hero-journey ships.
- User-customisable voice / style picker — fixed per template in v1.
- Cross-domain integration with the `editor` worker — we mirror its Q&A *style* only.
