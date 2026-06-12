# Book Generators — Design Spec

- **Date:** 2026-04-26
- **Status:** Design (pre-implementation)
- **Owner:** aloe (`aloewright`)
- **Repo (planned):** `aloewright/bookgenerators` → `/Users/aloe/Development/bookgenerators/`
- **Domain:** bookgenerators.com
- **Cloudflare account:** aloew@pdx.edu (same account as Quill / Post Pilot)

---

## 1. Summary

Book Generators is a multi-tenant SaaS for solo authors that takes them from market research to a launch-ready Kindle + Audible book. The product is structured as five skills — Market Scout, Book Architect, Chapter Writer, Publisher Pack, Launch Handoff — coordinated by an opinionated chat agent named **Aloysius**. The user works in a hybrid surface: a structured scaffold (Concept → Voice → Outline → Chapters → Publish → Launch) with a persistent chat sidecar for craft-level nudges.

The runtime is a single Cloudflare Worker fronting a React 19 SPA, with one Durable Object Agent per book project (Agents SDK), heavy compute in Cloudflare Workflows + Queues feeding a single `render-worker` Container (`pandoc`, `libreoffice`, `ffmpeg`, `kindlegen`), and all model calls routed through Cloudflare AI Gateway dynamic routes. v1 ships nonfiction-first; the chassis is genre-agnostic and fiction (multi-voice TTS, fiction frameworks) is additive in v1.5.

## 2. Goals & non-goals

### Goals

- **G1.** A solo author can go from "I want to write a book about X" to a launch-ready package (manuscript bundle + KDP metadata + ACX-ready audio + GTM brief) without leaving the app.
- **G2.** Output writes credibly in the user's voice — sourced either from the user's own samples or from the Post Pilot voice library at postpilot.cc.
- **G3.** Aloysius behaves like an opinionated editor: surfaces options, makes recommendations, defers to the user on final calls. Coaching but decisive. Never generic.
- **G4.** Costs are predictable and visible: per-user daily budget caps with circuit breakers; surfaced in-app.
- **G5.** All LLM/embedding/TTS/image calls go through Cloudflare AI Gateway dynamic routes. No direct provider calls.
- **G6.** Production deploy is one Worker + one Container service + Workflow + Queue infrastructure. No third-party SaaS dependencies that aren't behind the gateway (besides Stripe later, BYOK ElevenLabs for Pro users, postpilot.cc for voice imports).

### Non-goals (for v1)

- **NG1.** KDP / ACX direct upload via Selling Partner API. The user uploads artifacts themselves.
- **NG2.** Native posting to X / IG / LinkedIn. Launch Handoff *generates* the GTM brief; a future "marketing agent" will handle scheduling/posting.
- **NG3.** Translations / multilingual books.
- **NG4.** Fiction multi-voice TTS (single-voice nonfiction first; fiction multi-voice is v1.5).
- **NG5.** Real-time multi-user collaboration. One author per project; "invite reader" comments deferred.
- **NG6.** Mobile-first UI. v1 is desktop ≥1024px; mobile shows a "best on desktop" banner.
- **NG7.** Cover-image generation. KDP cover work is its own product.
- **NG8.** Stripe payments at launch. Architecture is built for Free + Pro tiers but everyone is Pro during the ~30–60 day beta.

## 3. Personas & flows

### Persona: Solo author

Writes nonfiction (primarily) or fiction. Has a draft idea, sometimes a niche, sometimes nothing. Wants to ship in weeks, not years. Needs an opinionated collaborator that makes craft decisions when asked, but never overrides voice. Mid-funnel: comfortable with KDP, may or may not know ACX.

### Primary user flow

1. **Sign up** → lands on Pro tier (during beta) → sees empty `/dashboard` with "New Book" CTA.
2. **New project** → name + nonfiction/fiction toggle → `/projects/$id/concept`.
3. **Concept**: optional Market Scout query inline, free-form niche notes, target reader, central promise. Aloysius is available throughout.
4. **Voice**: pick from voice library (custom or Post Pilot) OR add new voice (paste/upload samples; URL fetch deferred). For new custom voices, run the distillation pass → editable JSON+md profile.
5. **Outline**: Architect runs the questionnaire, picks framework (auto-suggested), generates chapter shells with target words and beats.
6. **Chapters**: section-by-section drafting in BlockNote. Streaming. Per-section accept / regenerate / inline-edit / reject. Chat sidecar carries craft conversation throughout.
7. **Publish**: SEO synthesis (title, subtitle, description, 7 keywords, 2 BISAC), KDP fillable preview, narration cast (single voice for nonfiction), audition gate, manuscript export workflow (epub + docx + pdf + kpf), audiobook mastering workflow.
8. **Launch**: GTM brief — pull quotes, X/IG/LinkedIn posts, ARC blurb, pricing rec — packaged as `gtm-brief.md` + `gtm-brief.zip` + structured `gtm-brief.json` for handoff to a future marketing agent.

### Secondary flow: Standalone Market Scout

A user can run Market Scout from `/scout` without committing to a project. Findings persist in `market_findings`; can later be attached to a project at creation time.

## 4. Architecture

### 4.1 Top-level shape

- One Cloudflare Worker at `bookgenerators.com`. Hono on the server side. Vite-built React SPA served as static assets with SPA-fallback (`not_found_handling: "single-page-application"`).
- Routing: Hono mounts `/api/*` (Better Auth + REST) and `/agents/*` (Agents SDK WebSocket); the asset binding serves everything else.
- One Durable Object Agent (`Aloysius`, class name `BookProjectAgent`) per project, addressed by `project_id`. Holds: chat history (also mirrored to D1 for durability), WebSocket connections to active sidecar clients, ephemeral "what is the user looking at" hints.
- Stateless skill modules in `src/skills/*`. Pure functions of `(ctx, params)`. Both REST endpoints and Aloysius's tool calls invoke the same modules — no logic duplication.
- Heavy compute lives in Cloudflare Workflows. Workflows fan out to Queues consumed by a single `render-worker` Container that ships `pandoc`, `libreoffice` (headless), `ffmpeg`, and `kindlegen`.
- All model/embedding/TTS/image calls go through Cloudflare AI Gateway dynamic routes. Helper at `src/lib/gateway.ts` is the only place that knows the gateway URL.

### 4.2 Why one DO per project (not per user)

The Agents SDK is designed conversation-scoped. Per-project DOs give clean isolation: each book has its own chat history, its own current "open chapter," its own WebSocket fanout. A user with 5 books has 5 DOs — fine on Cloudflare's pricing model. Per-user DO would force serialization of conversations across books and complicate the chat replay logic.

### 4.3 Why skill modules are pure (not their own DOs)

Two reasons:
1. **Testability.** Pure functions over `(ctx, params)` are trivial to unit-test with a mock env. A skill-per-DO architecture forces every test through the DO simulator.
2. **No state to coordinate.** All persistent state lives in D1 + R2. The DO's role is conversation state and WebSocket fanout — not skill logic.

Aloysius DO calls skill modules directly (in-Worker function call). REST endpoints call skill modules directly. Same code path; same behavior; single source of truth.

### 4.4 Why no Vectorize in v1

Voice profiles are distilled into a structured doc (per Q6b-B). The Chapter Writer's prompt has the full profile inline — no retrieval needed. Adding Vectorize for cross-project semantic search ("find me voices like Brené Brown but more sardonic") is a v1.5 feature when we have data justifying it.

## 5. Data model

### 5.1 D1 schema (Drizzle)

14 tables, grouped:

**Identity & auth**
- `users(id, email, plan, phase, daily_budget_cents, elevenlabs_key_ciphertext?, elevenlabs_key_iv?, stripe_customer_id?, created_at)` — `phase enum('chassis'|'architect'|'writer'|'publisher'|'scout'|'launch')` gates phased rollout independently from `plan`.
- Better Auth's `accounts`, `sessions`, `verifications` tables — managed by the Better Auth Drizzle adapter; sessions also live in KV via the secondaryStorage adapter.

**Voice library**
- `voices(id, user_id → users, name, source enum('custom'|'postpilot'), postpilot_slug?, profile_md, profile_json, created_at, updated_at)`
- `voice_samples(id, voice_id → voices, r2_key, source enum('paste'|'upload'|'url'), word_count, created_at)`

**Project & manuscript**
- `projects(id, user_id → users, title, type enum('nonfiction'|'fiction'), genre, status, voice_id? → voices, target_word_count, created_at, updated_at, deleted_at?)`
- `outlines(id, project_id → projects, framework, structure_json, version, created_at, updated_at)`
- `chapters(id, project_id → projects, ordinal, title, summary, status, target_words, draft_json, draft_md, created_at, updated_at)`
- `sections(id, chapter_id → chapters, ordinal, kind, prompt, draft_md, status, created_at, updated_at)`

**Revisions & chat**
- `revisions(id, target_table, target_id, before_md, after_md, llm_response, created_at)` — polymorphic audit log, keyed by `(target_table, target_id)`. Indexed.
- `chat_messages(id, project_id → projects, role enum('user'|'assistant'|'tool'), content_json, model, route, tokens_in, tokens_out, cost_cents, created_at)`

**Market Scout**
- `market_queries(id, user_id, project_id?, niche, type, params_json, created_at)`
- `market_findings(id, query_id → market_queries, dataset_snapshot_id → dataset_snapshots, summary_md, evidence_json, created_at)`
- `dataset_snapshots(id, week_iso, r2_key, source, created_at)` — global, shared across users.

**Publisher & GTM**
- `publisher_packs(id, project_id → projects, title, subtitle, description_html, keywords_json, bisac_json, status, created_at, updated_at)`
- `gtm_briefs(id, project_id → projects, content_json, brief_md, r2_key, created_at, updated_at)`

**Jobs & usage**
- `render_jobs(id, project_id → projects, kind enum('epub'|'docx'|'pdf'|'kpf'|'narration'|'master_mix'), status, workflow_id, output_r2_key?, error?, started_at, completed_at?, cost_cents)`
- `usage_daily(id, user_id, day_iso, route, tokens_in, tokens_out, cost_cents)`

Cascade rules: project soft-delete (`projects.deleted_at`) cascades logically to all project-owned rows (we soft-delete via the `deleted_at` column rather than physically removing). R2 lifecycle policy purges `projects/{id}/**` 30 days after `deleted_at`. Hard delete via admin tool only.

### 5.2 R2 layout

```
voices/{voice_id}/samples/{sample_id}.{ext}
projects/{project_id}/manuscript/v{n}/manuscript.{epub|docx|pdf|kpf}
projects/{project_id}/audio/{chapter_id}.mp3
projects/{project_id}/audio/master.mp3
projects/{project_id}/gtm-brief.md
projects/{project_id}/gtm-brief-assets.zip
datasets/market/{week_iso}.json
staging/{job_id}/manuscript.md           # ephemeral; cleared on lifecycle
```

### 5.3 KV keys

- `session:{session_id} → user_id` (Better Auth)
- `budget:{user_id}:{day_iso} → cents_spent` (atomic CAS counter)
- `circuit:{user_id}:{route} → {state, until}` (open/closed circuit breaker)
- `market_dataset:{week_iso}:index → r2_key` (latest pointer)
- `postpilot:{slug}:prompt → text` (24h TTL cache of Post Pilot voice imports)

## 6. Skill specs

Each skill is a stateless TS module in `src/skills/*`. Both REST endpoints and Aloysius tool calls invoke the same module.

### 6.1 Market Scout — `src/skills/scout.ts`

- **Inputs:** `niche`, optional `project_id`, optional BYO upload (Publisher Rocket / KDSPY CSV).
- **Process:** Load latest weekly dataset snapshot from R2 → enrich with Google Trends (free public API) and Google Books category tree → synthesize via `dynamic/research_gen` → persist `market_findings`.
- **Outputs:** `market_queries` + `market_findings` rows; `evidence_json` is charts-ready.
- **Surface:** `/scout` page (standalone) + "Run Scout" button on project setup + chat tool `scout(niche)`.
- **Cron:** Weekly Mon 06:00 UTC refreshes `datasets/market/{week_iso}.json`. Crawls public Amazon bestseller HTML pages + Audible browse pages + KDP free-promo lists. Defensive against rate limiting (single-threaded, polite delays). Falls back to last week's data on any failure.
- **Free-tier gate:** 5 queries/month per user during beta everyone Pro this is dormant.

### 6.2 Book Architect — `src/skills/architect.ts`

Three phases, callable independently:

- **`questionnaire(project_id)`** — generates ~8 questions via `dynamic/text_gen`, shaped by genre+framework. For nonfiction: reader/struggle/promise/proof. For fiction: protagonist/want/need/wound. User answers in the editor.
- **`distill(voice_id, samples[])`** — distills voice samples into a structured profile (`profile_md` for human edit, `profile_json` for prompt injection). Schema includes: sentence-length distribution, vocabulary register, signature moves, common cadences, "things this voice never does." Editable by the user post-distillation.
- **`outline(project_id)`** — given questionnaire answers + voice profile + framework, generates `outlines.structure_json` as `{ acts: [{ chapters: [{ sections: [{ kind, prompt, target_words, beat }] }] }] }`. Creates `chapters` rows. Editable in the Outline view.

**Frameworks shipped (v1):** Nonfiction — StoryBrand, AIDA, Problem-Agitate-Solve. Fiction — Hero's Journey, Save the Cat, Three-Act. Framework module is pluggable: each framework is a `src/skills/shared/frameworks/{type}/{name}.ts` exporting a `Framework` interface (questionnaire prompt, structure generator, beat templates).

**AI route:** `dynamic/text_gen`, temp 0.8 for ideation phases, 0.3 for structure generation.

### 6.3 Chapter Writer — `src/skills/writer.ts`

- **Inputs:** `chapter_id` (knows beats and target words), voice profile, prior 1–2 sections for continuity.
- **Process:** section-by-section. For each section: load `section.prompt` + voice profile + continuity context → `dynamic/text_gen` (medium temp 0.7) → stream tokens via WebSocket *both* to chat sidecar (visible) and to BlockNote editor (live block update). After completion, user can per-section: accept / regenerate (whole section) / inline-edit (sentence-level via BlockNote AI hooks) / reject-with-note.
- **Each operation creates a `revisions` row** keyed by `(target_table='sections', target_id)`. Substantive-change threshold: ≥10 char diff for manual edits.
- **Outputs:** `sections.draft_md` per section, assembled `chapters.draft_json` (BlockNote doc) and `chapters.draft_md` (rendered). Audit trail in `revisions`.
- **Surface:** Chapter editor (BlockNote) + per-section Regenerate button + chat tools `writer.{generate_section, regenerate, revise}`.
- **AI route:** `dynamic/text_gen`. BlockNote AI hooks (`@blocknote/xl-ai`) are wired through a custom adapter (`client/components/editor/ai-adapter.ts`) that calls `/api/v1/writer/inline-edit` — Worker-side, gateway-routed, never direct.

### 6.4 Publisher Pack — `src/skills/publisher.ts`

Five sub-pipelines under one tab:

- **`seo(project_id)`** — `dynamic/text_gen` produces 3 title/subtitle alternates, description (HTML, ≤4000 chars), 7 keywords ranked by estimated reach, 2 BISAC categories from a curated tree (`src/skills/shared/bisac.ts`). Persists to `publisher_packs`. Surfaces in a fillable form preview that mirrors KDP's actual layout.
- **`render(project_id, formats[])`** — kicks `BookExportWorkflow` (see §7).
- **`narration_script(chapter_id)`** — TTS rewrite pass via `dynamic/text_gen`: expanded abbreviations, pronunciation hints in `[brackets]`, breath beats. Idempotent on `(chapter_id, draft_md_hash)`.
- **`audition(project_id, voice_choice, sample_text)`** — renders 2-paragraph sample via `dynamic/audio_gen`. Aura on Free tier; ElevenLabs (BYO key) on Pro. Returns `R2://projects/{id}/audio/audition/{voice_id}.mp3`. UI plays inline.
- **`audiobook(project_id)`** — kicks `AudiobookMasteringWorkflow` (see §7). Requires audition acceptance.

**Surface:** `/projects/$id/publish` tab + chat tools `publisher.{seo, render, audition, narrate}`.

### 6.5 Launch Handoff — `src/skills/launch.ts`

- **Inputs:** completed project + `publisher_packs`.
- **Process:** chained `dynamic/text_gen` calls (pull quotes → X posts → IG carousels → LinkedIn → ARC blurb → pricing + hashtags). Wrapped in `GtmBriefWorkflow` for resilience (long chains can fail mid-way; durable retries are nice).
- **Outputs:** `gtm_briefs` row + `R2://projects/{id}/gtm-brief.md` + `R2://projects/{id}/gtm-brief-assets.zip` (text files + JSON) + structured `gtm-brief.json` (handoff schema).
- **Pricing defaults:** Nonfiction $0.99 promo / $4.99 standard. Fiction $2.99 promo / $7.99 standard. Adjusted by length and category.
- **Surface:** `/projects/$id/launch` tab (brief preview, downloads, "Open in marketing agent" placeholder) + chat tool `launch.brief()`.

## 7. Heavy ops pipeline

### 7.1 `BookExportWorkflow`

- **Trigger:** REST `POST /api/v1/projects/$id/render { formats: ['epub','docx','pdf','kpf'] }` or chat tool.
- **Steps:**
  1. `assemble` — D1 chapters → markdown bundle → `R2://staging/{job_id}/manuscript.md`.
  2. Parallel via `ctx.do.step()`: `epub` (container.pandoc), `docx` (container.pandoc), `pdf` (container.libreoffice), `kpf` (container.kindlegen). Each writes to `R2://projects/{id}/manuscript/v{n}/manuscript.{ext}`.
  3. `finalize` — `render_jobs.status='completed'`, `Aloysius.notifyJobs(project_id)` via DO RPC.
- **Latency:** 30–90s for nonfiction-typical (~50k words). PDF + KPF are the slow steps.
- **Retry:** 3× exp backoff per step. Idempotent on `job_id`.

### 7.2 `AudiobookMasteringWorkflow`

- **Trigger:** REST `POST /api/v1/projects/$id/audiobook` after audition acceptance.
- **Steps:**
  1. `narration_scripts` — `writer.narration_pass` per chapter via `dynamic/text_gen`. Idempotent on `(chapter_id, draft_md_hash)`.
  2. `audition_gate` — `ctx.waitForEvent('audition_ok')`. Workflow durably parks until user posts to `POST /api/v1/projects/$id/audition/accept`. Could be hours.
  3. `chapter_tts_fanout` — emits one Queue message per chapter to `render-narration`. Concurrency cap = 3 (rate-limit polite for ElevenLabs and Aura). Each consumer calls `dynamic/audio_gen`, writes `R2://projects/{id}/audio/{chapter_id}.mp3`.
  4. `master_mix` once all chapters land — `container.ffmpeg` concat with chapter markers (`-metadata:s:0 chapter=...`), intro slate, outro slate. Writes `R2://projects/{id}/audio/master.mp3`.
  5. `finalize` — write ACX submission manifest (`projects/{id}/audio/acx-manifest.json`), `Aloysius.notifyJobs`.
- **Latency:** 5–15 min for 50k-word book.
- **Retry:** per-chapter retries (chapter 7 fails, chapter 8 still proceeds). Master-mix is single retry.
- **BYOK enforcement:** ElevenLabs voices require `users.elevenlabs_key_ciphertext IS NOT NULL`; otherwise returns `402 BYOK_REQUIRED` before workflow starts.

### 7.3 `GtmBriefWorkflow`

Sequential `dynamic/text_gen` calls, each a Workflow step (durable across LLM rate-limits).

### 7.4 `MarketDatasetRefreshCron`

Weekly Mon 06:00 UTC. Fetches public Amazon bestseller pages (top 100 per major category), Audible browse pages, KDP free-promo daily list. Normalizes → `R2://datasets/market/{week_iso}.json`. Updates `KV: market_dataset:latest → r2_key`. Polite single-threaded crawl with backoff. Failure path: log + retry next Wed 06:00 UTC.

### 7.5 `render-worker` Container

- **Dockerfile:** `FROM debian:bookworm-slim` + `pandoc` + `libreoffice-core` + `ffmpeg` + `kindlegen` (Linux build; if Amazon ever drops it, swap to Kindle Previewer 3 CLI under wine).
- **HTTP API (Hono):** `POST /render/{epub,docx,pdf,kpf}`, `POST /audio/{concat,master}`, `GET /health`. Authorization: `X-Internal-Token: ${RENDER_WORKER_INTERNAL_TOKEN}`.
- **Bytes flow:** Worker passes R2 keys, not bytes. Container reads/writes R2 via S3-compat creds (`S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` env vars set on the container).
- **Autoscale:** `min: 0, max: 4`. Cold-start ~2–3s; acceptable for these latencies.

### 7.6 Status streaming back to Aloysius

Every Workflow step writes `render_jobs.status` and calls `Aloysius.notifyJobStatus(jobId)` via DO RPC. Aloysius pushes `{type: 'job_status', job_id, kind, status, progress?}` to the WebSocket. Sidecar shows inline pills ("Rendering ePub… ✓ 8s"). Publish tab shows the full job table.

## 8. UI surface

### 8.1 Routes (TanStack Router file-based)

- `/` — marketing landing (minimal v1: hero + 3 feature blurbs + beta CTA)
- `/sign-in`, `/sign-up` — Better Auth
- `/dashboard` — project list with state pills
- `/projects/$id` (with subroutes `/concept`, `/voice`, `/outline`, `/chapters[/$chapterId]`, `/publish`, `/launch`)
- `/scout` — standalone Market Scout
- `/voices` — voice library (custom + Post Pilot imports)
- `/account` — plan, daily budget, BYOK ElevenLabs key, sign-out

### 8.2 Project workspace

Three-pane layout:
- **Top bar:** project title (edit-in-place), status pill, daily-budget meter, profile dropdown.
- **Left rail (200px):** outline tree (6 modes); expanded chapter list when in Chapters mode.
- **Center:** mode-specific editor.
- **Right rail (320px, collapsible):** Aloysius chat sidecar — persistent across modes, WebSocket-streamed, slash-commands for explicit skill invocation, inline tool-call display.

### 8.3 Chapter editor

BlockNote document is a sequence of section-blocks. Each section-block: `data-section-id`, `data-status`, status border color (gray pending / gold generating / green drafted / blue approved), inline action menu (regenerate / edit / ask Aloysius). Streaming-write is live token application to the BlockNote node. BlockNote's `@blocknote/xl-ai` AI hooks are routed through a custom Worker-side adapter — never direct provider calls.

### 8.4 Aloysius behavior

- Persona system prompt: "Expert creative collaborator — opinionated on craft, precise on platform mechanics. Coaching but decisive. Surfaces options, makes recommendations, defers to the user on final calls. Never generic."
- Tool catalog dynamically scoped to current mode (Chapters mode exposes `writer.*`; Publish mode exposes `publisher.*`; etc.).
- Streams responses via Agents SDK WebSocket.
- Inline tool-call display in chat thread for transparency.

### 8.5 Mobile

v1 desktop-only (≥1024px). Below that, "Best on desktop" banner. Continue-anyway is allowed but unsupported.

## 9. Auth, plans, budgets

### 9.1 Better Auth

Email + password. Sessions in KV via the secondaryStorage adapter. `users.plan` defaults to `'pro'` during beta. `/api/auth/*` mounted by the Better Auth Hono adapter. No email verification in v1 (Resend integration deferred).

### 9.2 Plan gates

`requirePro()` middleware short-circuits with `402 { code: 'PLAN_REQUIRED', upgradeUrl }`. Gates:
- ElevenLabs voices (`audition` + audiobook with ElevenLabs voice)
- Market Scout queries beyond 5/month
- More than 1 voice in library
- PDF, KPF, master-mix outputs

During beta, every user is Pro; gates are dormant but in-place.

### 9.3 Budgets

Every skill-module entry begins with `await assertBudget(ctx, route)`. Looks up `KV: budget:{user_id}:{day_iso}`, compares to `users.daily_budget_cents`, throws `BudgetExceeded` if over. After successful AI call, increments KV counter via CAS loop and inserts a `usage_daily` row.

Defaults populated on signup: `users.daily_budget_cents = 1000` for Free, `5000` for Pro. Plan upgrade automatically bumps to Pro default unless the user has manually overridden. Override via `/account` per-user.

### 9.4 Circuit breakers

Per-user, per-route. After 3 consecutive failures within 60s, `KV: circuit:{user_id}:{route}` flips to `open` for 5 minutes. Subsequent calls 503 with friendly Aloysius message. Manual reset from Account.

## 10. AI Gateway routing

All model calls route through Cloudflare AI Gateway dynamic routes. Single helper at `src/lib/gateway.ts`:

| Function | Dynamic route | Used by |
|---|---|---|
| `chatCompletion` | `dynamic/text_gen` | Architect questionnaire, Writer (sections + inline edits), Publisher SEO + narration script, Launch Handoff |
| `researchCompletion` | `dynamic/research_gen` | Market Scout synthesis |
| `gatewayEmbedding` | `dynamic/ai_embed` | (Reserved for v1.5 Vectorize integration) |
| `audioGen` | `dynamic/audio_gen` | Audition + per-chapter narration |
| `imageGen` | `dynamic/image_gen` | (Reserved for v1.5 cover suggestions) |

Endpoint: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/compat/chat/completions` (and the route-specific equivalents). Headers: `Content-Type`, `cf-aig-authorization: Bearer ${CF_AIG_TOKEN}`, `cf-aig-zdr: true`. Body's `model` field is the dynamic route slug (never a raw provider id).

Inside the Worker, prefer `env.AI.run("dynamic/text_gen", { messages }, { gateway: { id: "x" } })` where the AI binding is convenient; fall back to the HTTP form via the helper for routes the AI binding doesn't support.

Skill modules call only the helper. Provider names never appear in skill code.

## 11. Post Pilot integration

`src/skills/shared/postpilot.ts` — typed client wrapping:
- `GET https://postpilot.cc/v1/guides[?era=&useCase=&voice=&q=]`
- `GET https://postpilot.cc/v1/guides/:slug?format=prompt`

Cached in KV with 24h TTL keyed by `(slug, format)` or `(query_string)` for the list endpoint. No auth (read endpoints are public per Quill's current behavior; verify before launch).

When a user imports a Post Pilot voice into their library: copy the `prompt` text into `voices.profile_md`, mark `voices.source='postpilot'`, set `voices.postpilot_slug`. Subsequent edits in the user's library don't propagate back to Post Pilot.

## 12. Observability & ops

- **Cloudflare Workers Observability** enabled (`observability.enabled: true`, `head_sampling_rate: 1`).
- **AI Gateway dashboard** — tracks LLM usage, errors, cache hit rate. No additional code needed.
- **`/account` page** surfaces `usage_daily` aggregates as a simple bar chart.
- **No Sentry** in v1 — Workers Observability covers errors and traces.
- **Container logs** surfaced via Workers Observability when called from the Worker.

## 13. Testing

- **Unit (Vitest):** Skill modules, framework modules, BISAC mapper, voice-profile schemas. AI Gateway calls use a `recordingMode: 'replay'` adapter that reads taped JSON fixtures from `tests/__fixtures__/gateway/`. CI never hits live LLMs.
- **Integration (`@cloudflare/vitest-pool-workers`):** Hono routes + DO + Workflows in a real Workers runtime against in-memory D1 + R2 + KV.
- **E2E (Playwright):** sign-up → create project → write 1 chapter → publish ePub → render GTM brief. ~5 happy-path tests for v1.
- **Coverage targets:** 70% for skill modules; 50% overall (don't chase coverage on UI components).

## 14. Secrets & config

### 14.1 Environment vars (`wrangler.jsonc`)

- `ENV` = "dev" | "prod"
- `DEFAULT_MODEL` = "@cf/zai-org/glm-4.7-flash" (or whatever the latest cheap-default is at deploy time)
- `RESEARCH_MODEL` = "anthropic/claude-opus-4-7" (routed through the gateway dynamic route, but the route picks the actual model — this is a hint)
- `IMAGE_MODEL` = "openai/gpt-image-2"
- `AI_GATEWAY_ID` = "x"
- `POSTPILOT_BASE_URL` = "https://postpilot.cc"

### 14.2 Cloudflare secrets

- `BETTER_AUTH_SECRET`
- `AI_GATEWAY_BASE_URL`
- `AI_GATEWAY_TOKEN`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (R2 S3-compat creds for Container access)
- `RENDER_WORKER_INTERNAL_TOKEN` (worker → container shared secret)
- `KEYRING_MASTER_KEY` (encrypts BYOK ElevenLabs keys at rest)

### 14.3 BYOK secrets

ElevenLabs API keys per Pro user are AES-256-GCM encrypted in `users.elevenlabs_key_ciphertext` with `users.elevenlabs_key_iv`, key derived from `KEYRING_MASTER_KEY`. Never logged. Decrypted only inside the audiobook workflow at TTS-call time.

### 14.4 Doppler → Wrangler mirror

`scripts/bootstrap.sh` mirrors Doppler config to Wrangler secrets on deploy (matches Quill's pattern).

## 15. Repo layout

```
bookgenerators/
├── apps/web/
│   ├── src/
│   │   ├── index.ts              # Hono entry
│   │   ├── auth.ts               # Better Auth wiring
│   │   ├── agents/aloysius.ts    # BookProjectAgent (DO)
│   │   ├── routes/               # auth, projects, voices, chapters, scout, publish, launch, jobs, health
│   │   ├── skills/               # scout, architect, writer, publisher, launch + shared/{postpilot, voice-profile, frameworks/, bisac}
│   │   ├── workflows/            # book-export, audiobook-mastering, gtm-brief, market-refresh.cron
│   │   ├── lib/                  # gateway, budget, circuit, ws helpers
│   │   ├── middleware/           # auth, budget, error
│   │   └── db/                   # Drizzle schema + generated migrations
│   ├── client/
│   │   ├── main.tsx
│   │   ├── index.css             # Tailwind v4 + tokens
│   │   ├── routes/               # TanStack Router file-based
│   │   ├── components/           # editor (BlockNote), chat, outline, publisher, launch, ui
│   │   └── lib/                  # api, ws
│   ├── drizzle/                  # generated migrations
│   ├── wrangler.jsonc
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── services/render-worker/
│   ├── src/index.ts              # Hono inside container
│   ├── Dockerfile                # debian + pandoc + libreoffice + ffmpeg + kindlegen
│   ├── package.json
│   └── tsconfig.json
├── packages/shared/
│   ├── src/                      # types + framework registry shared across web + render
│   └── package.json
├── docs/superpowers/specs/
│   └── 2026-04-26-bookgenerators-design.md   # this file, moved on scaffold
├── scripts/
│   ├── bootstrap.sh              # provisions D1 + KV + R2 + Container + secrets
│   ├── refresh-market-dataset.ts # local run of cron
│   └── deploy.sh
├── .gitignore
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── README.md
```

## 16. Deployment

Manual `wrangler deploy` from `main` for v1 — solo author scale, low velocity. `scripts/deploy.sh` wraps `pnpm build && wrangler deploy && wrangler containers deploy render-worker`. Domain bound via `routes` in `wrangler.jsonc` (`bookgenerators.com/*`). DNS in Cloudflare. GitHub Actions deferred until contribution velocity warrants it.

## 17. Open questions / risks

- **`kindlegen` Linux availability.** Amazon's old binary still works for KPF generation but is unmaintained. Fallback: Kindle Previewer 3 CLI under wine. Worth a 1-day spike during chassis build to confirm.
- **ACX submission practicalities.** ACX requires per-chapter MP3s plus retail audio sample, opening credits, closing credits, and a copyright page MP3. The audiobook workflow generates per-chapter MP3s and the master mix; the additional submission assets (sample, credits, copyright) are scripted into the manifest but generated as deterministic templates from project metadata. Field-test with a real submission before declaring v1 done.
- **ElevenLabs cost runaway.** A 50k-word book ≈ 5h audio ≈ 250k characters. At ElevenLabs current pricing (~$0.30/1k chars on the lower tiers) that's ~$75/book. BYOK isolates us from this cost but the Pro user might be surprised. Audition + per-chapter cost preview before committing the full audiobook.
- **Workflow long-park costs.** `audition_gate` may park for hours/days. Confirm Cloudflare Workflows pricing for parked steps; if non-trivial, fall back to a separate trigger flow.
- **Post Pilot API stability.** External dependency. Add a graceful degrade: if `postpilot.cc` is unreachable, the voice-source dropdown shows custom voices only and a banner notes the import library is offline.

## 18. Implementation order (informational)

This spec is genre-agnostic. The implementation plan (next step, via `writing-plans` skill) will sequence:

1. **Chassis** — Worker + SPA scaffold + D1/R2/KV/Container provisioning + Better Auth + dashboard + project CRUD + Aloysius DO (chat-only stub) + AI Gateway helper.
2. **Book Architect** — voice library + Post Pilot import + framework modules + questionnaire + outline generator.
3. **Chapter Writer** — BlockNote editor + section streaming + revisions + inline AI edits.
4. **Publisher Pack** — SEO synth + KDP fillable + render-worker Container + BookExportWorkflow + narration script + audition + AudiobookMasteringWorkflow.
5. **Market Scout** — weekly cron + dataset crawl + standalone page + project integration.
6. **Launch Handoff** — GtmBriefWorkflow + brief preview + downloads + handoff JSON schema.

Each phase is gated by a `phase` enum on `users` (separate from `plan`): `chassis | architect | writer | publisher | scout | launch`. New users land on the most-recently-shipped phase; the owner can bump individual users to the latest in-progress phase for dogfooding.

---

*End of design spec.*
