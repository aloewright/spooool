# Spooool E10 (Native Editing) + E11 (AI Studio) — Design Spec (rev. 2)

## Context

Spooool is a Cloudflare-native video host ("a video host that respects your time"): React 18 + Vite SPA served by a Hono Worker (`src/workers/index.ts`) via the `[assets]` binding with SPA fallback. Today's creation surface is a prompt-to-video flow (`src/workers/create.ts`, `create-tools.ts`, `create-cma.ts`, `composer-agent-do.ts`) that drafts a script, plans scenes, synthesizes TTS, and renders an explainer through a per-user Remotion container (`container/render/`). Playback is unified on `@cloudflare/stream-react` (`src/frontend/lib/stream-player.tsx`). All AI today is hand-rolled around `env.AI.run('@cf/...', input, { gateway: { id: 'x' } })` — the only Worker-side gateway invocation that works.

We are adding two independently-shippable epics:

- **E10 — Native Editing**: a full browser timeline editor (trim, split, reorder, captions, transitions) backed by the Stream Clipping API + Media Transformations + the existing Remotion render pipeline. Plus lightweight Media-Transformations "wins" (auto-poster, social crop, preview GIF/spritesheet, trim-to-share).
- **E11 — AI Studio**: standardize all generation onto `@tanstack/ai` with a Cloudflare-Gateway transport, surfacing chat-driven scripting, image gen (thumbnails/b-roll), generative video b-roll, TTS, transcription/captions, and AI metadata.

## Goals

- Ship E10 and E11 as separate epics with no hard runtime coupling (E11 can write a caption track E10 consumes, but neither blocks the other's launch).
- Keep every model call gateway-routed **with observability/caching preserved** (no silent regression vs today's `{ gateway: { id: 'x' } }`); keep `lint:no-providers` (`scripts/check-no-direct-providers.mjs`) green.
- Reuse the existing render → encode → Stream pipeline so edited/generated output flows through `submitRenderJob` → container callback → `videos` row → `VIDEO_ENCODING` → Stream, unchanged downstream.
- Respect E9 bundle discipline: editor is a lazy route, heavy deps in dedicated `manualChunks`.

## Non-goals

- No server-side Stream concatenation (Stream cannot stitch; only the Remotion container stitches).
- No Polar paywall changes in this spec (paid tiers route through Polar per memory; E11 only adds quota knobs the existing tiering can read).
- No replacement of the ComposerAgent alarm-driven DO architecture — we refactor its *tool implementations* onto `@tanstack/ai`, not its staging model.

## Architecture

```
                        BROWSER (React 18 SPA, lazy routes)
  /edit/:videoId  ── TimelineEditor ─┐         /studio ── AIStudio (useChat)
  (EDL data model, scrubber on       │          (chat, image, video b-roll,
   @cloudflare/stream-react)         │           captions, metadata panels)
            │ editor-client.ts       │                  │ studio-client.ts (SSE + poll)
            ▼                        ▼                  ▼
  ┌──────────────────────────  HONO WORKER (src/workers/index.ts)  ───────────────────────┐
  │  edit.ts (/api/edit/*)            studio.ts (/api/studio/*)         create.ts (refit)  │
  │   - POST /clip  ──fetch──┐         - POST /chat  (SSE stream)        - /auto, /sessions │
  │   - projects CRUD        │         - POST /image                                       │
  │   - POST /render (EDL)   │         - POST /video  (enqueue AI_GEN)   create-tools.ts    │
  │   - /transform helpers   │         - POST /captions                  (refactored onto   │
  │   - Stream→R2 prestage    │         - /metadata                        @tanstack/ai)     │
  │      (MEDIA binding)     │                                                              │
  └──────────┬───────────────┼───────────────┬──────────────────────────┬────────────────┘
             │               │               │                          │ async queue handler
   env.STREAM │     api.cloudflare.com  ai-gateway.ts: gatewayChat/Image/Tts/         AI_GEN
   env.MEDIA  │     /stream/clip (REST)   Transcription → env.AI.run('@cf/<model>',   consumer
   (R2 byte   │                           input, { gateway: { id: 'x' } })  ──────┐  (video b-roll)
    streams)  ▼               ▼               │                          │        │
        ┌───────────┐   ┌───────────┐   AI GATEWAY 'x' (observability/cache)      │ env.AI.run(
        │  STREAM   │   │   R2      │        │                          │        │ 'google/veo-3.1',
        │ clip uid  │   │ VIDEOS    │        │                          │        │ {gateway:{id:'x'}})
        └─────┬─────┘   └─────┬─────┘   generated_assets.stream_video_id│        │ → result.video URL
              │ webhook        │         ◄── clip-ready resolution path ─┘        │ → env.STREAM.upload
              ▼ (stream-webhook.ts: videos OR generated_assets)                  ▼
        submitRenderJob(env) ──► RENDER_CONTAINER DO (per-user) ──► Remotion (R2-only sources)
              ▲ EDL → compositionProps.clips[] (per-clip trim, transitions, captions)
              │ Stream sources PRE-STAGED to R2 by Worker (downloads.generate + poll → R2)
        /api/render/jobs/:id/complete ──► videos row (status='queued') ──► VIDEO_ENCODING ──► Stream
```

Durable Object bindings referenced (exact wrangler names): `CHANNEL_SUBSCRIBER_DO`, `RATE_LIMITER`, `RENDER_CONTAINER`, `COMPOSER_AGENT`.

## TanStack AI through the AI Gateway — strategy (the crux, corrected)

The central tension: from inside a Worker, `dynamic/*` routes are broken on all three paths (`env.AI.run('dynamic/..')` 404s; `env.AI.gateway().run(compat)` skips the fallback chain / returns `{}`; `fetch()` to the compat endpoint hits CF error 2019). The only Worker-side invocation that works is `env.AI.run('@cf/<concrete-model>', input, { gateway: { id: 'x' } })` — which both targets a concrete model AND threads `{ gateway: { id: 'x' } }` so observability, caching, and cost analytics are preserved. This is exactly what `create-tools.ts` does today.

**Resolution — adopt `@cloudflare/tanstack-ai`, but DEFAULT to a gateway-routed invocation, not plain `{ binding: env.AI }`.** The reviewer correctly identified a silent regression in the previous design: `createWorkersAiChat(model, { binding: env.AI })` installs a fetch shim that calls `binding.run(model, inputs, { extraHeaders, signal })` — its `runOptions` contains **only** `extraHeaders` and `signal`, **no `gateway` option**. So plain-binding mode drops all gateway observability/caching that today's `{ gateway: { id: 'x' } }` provides. The previous claim that "each call passes a `gateway: { id: 'x' }` equivalent" in binding mode was **factually wrong and is removed**.

We resolve this with one of two gateway-routed paths, both of which keep observability, chosen via `AI_GATEWAY_MODE`:

1. **`gateway-binding` (preferred default):** `createWorkersAiChat(model, { binding: env.AI.gateway('x') })`. The Cloudflare adapter's `createGatewayFetch` calls `env.AI.gateway('x').run({ provider, endpoint, headers, query })` and emits `cf-aig-*` cache/metadata headers. The documented fallback-skip concern applies **only to `dynamic/*` routes**; here we target concrete `@cf/<model>` ids, so that concern does not apply. This is the design default.

2. **`run-gateway` (paranoia fallback, byte-for-byte parity with today's code):** a thin custom adapter/wrapper that calls `env.AI.run('@cf/<model>', inputs, { gateway: { id: 'x' } })` directly — identical to the working `create-tools.ts` call. We ship this if, on verification, `env.AI.gateway('x')` misbehaves for any activity on this account.

Both modes keep gateway routing. We never use `{ binding: env.AI }` plain mode in production because it loses observability. `AI_GATEWAY_MODE` is a single config flag (default `gateway-binding`), not a code fork.

We centralize this in `src/workers/ai-gateway.ts`, exporting named factory wrappers:

- `gatewayChat(env, model?)` → adapter per mode, default model `@cf/google/gemma-4-26b-a4b-it` (verified current/Hosted on this account; retained from today's create flow for output parity — the swap to `@cf/openai/gpt-oss-120b` is deferred to an Open Question rather than baked in).
- `gatewayImage(env, model?)` (default `@cf/black-forest-labs/flux-2-klein-9b` or `@cf/stabilityai/stable-diffusion-xl-base-1.0` — pin after verifying availability), `gatewayTts(env, model='@cf/deepgram/aura-2-en')`, `gatewayTranscription(env, model='@cf/openai/whisper-large-v3-turbo')`, `gatewaySummarize(env, model='@cf/facebook/bart-large-cnn')`.

Each factory threads cf-aig cache controls (`cacheTtl`, `skipCache`, `metadata: { op, userId }`) so AI Studio calls are filterable in the gateway dashboard.

**Generative video — corrected (no compat-fetch anywhere).** The previous design routed video b-roll through a "Node/queue compat fetch" to `dynamic/video_gen`. The reviewer correctly flagged that **a Cloudflare Queue consumer is still Worker-side code**, subject to the same CF-2019 rejection as the request path — a queue consumer is NOT a Node context. Research confirms this AND supplies a clean fix: Cloudflare's unified AI catalog exposes proxied text-to-video models (Veo 3.1, MiniMax Hailuo) callable through the **working binding pattern** from inside a Worker:

```ts
// canonical, Worker-safe, gateway-routed (from CF changelog)
const aiResponse = await env.AI.run('google/veo-3.1',
  { prompt, duration: '6s', aspect_ratio: '16:9', resolution: '720p', generate_audio: true },
  { gateway: { id: 'x' } });
const videoUrl = aiResponse.result.video;        // R2-hosted URL, state: 'Completed'
const streamVideo = await env.STREAM.upload(videoUrl);  // ingest to Stream
```

This is the same sanctioned `env.AI.run(<model>, input, { gateway: { id } })` shape, so it works from the Worker AND stays gateway-observable. `google/veo-3.1` is a unified-catalog provider id (not `@cf/`), but it is invoked through the binding, not a provider SDK or URL — and crucially the lint guard's forbidden model-id regexes only match `openai/gpt-`, `anthropic/claude-`, `google/gemini-` (verified in `check-no-direct-providers.mjs`), so `google/veo-3.1` does not trip lint. We still use an **`AI_GEN` queue** to decouple the long-running call from the request path (Veo can exceed the request budget), get retries, and avoid head-of-line blocking — but the queue consumer makes the **binding call**, never a compat fetch. `@tanstack/ai`'s `generateVideo` ships only fal/OpenAI adapters (no Cloudflare video adapter), so video b-roll bypasses `@tanstack/ai` and uses the raw binding call in `ai-video-consumer.ts`.

**lint:no-providers compliance.** The guard (`scripts/check-no-direct-providers.mjs`) scans `src/`, `scripts/`, `tests/` (excluding `*.test.*`); it does NOT scan `node_modules`. Forbidden: imports of `openai`/`@anthropic-ai/sdk`/`@ai-sdk/*`/etc., provider URLs (`api.openai.com`, …), and model ids matching `openai/gpt-*`/`anthropic/claude-*`/`google/gemini-*`. Allowed: `gateway.ai.cloudflare.com`, `dynamic/*` slugs, `env.AI` bindings, and `@cf/<model>` ids. `@cloudflare/tanstack-ai` imports `openai` transitively as a typed client (its fetch is shimmed), so the guard stays green as long as our source never imports `openai` directly. `google/veo-3.1` is not matched by any forbidden regex. We add a comment in `ai-gateway.ts` pointing at the CLAUDE.md Worker-quirk section so the path can be swapped to `dynamic/*` when upstream is fixed.

## E10 design — timeline editor

**Data model (Edit Decision List).** A project (`edit_projects`) owns an ordered `clips[]` EDL stored as JSON (`edl_json`). Each clip: `{ id, sourceKind: 'stream'|'r2', sourceRef (stream uid or r2 key), inFrames, outFrames, orderIndex, transitionIn?, captions?: CaptionCue[] }`. Frame math is fixed at 30fps to match `Root.tsx`. `CaptionCue = { startFrames, endFrames, text }`. The `CaptionCue` shape is defined once in `src/workers/edit-model.ts` and shared with E11's caption output.

**Trim via Stream Clipping.** When a clip's source is a Stream video and the user trims it for a *standalone* share, we call the REST Clipping API (`POST https://api.cloudflare.com/client/v4/accounts/{id}/stream/clip` with `clippedFromVideoUID/startTimeSeconds/endTimeSeconds`) from `src/workers/stream-clip.ts` (binding has no `clip()`), reusing the `CF_STREAM_API_TOKEN` auth pattern from `encoding.ts`. The clip is async (`status.state: queued→inprogress→ready`, `readyToStream:false` on the 200, `size:0`); we never treat the 200 as ready. We re-pass `requireSignedURLs/allowedOrigins/meta.name/scheduledDeletion/creator` (none are inherited; an on-demand clip is a NEW billable Stream video).

**Clip ready-notification path (corrected).** The reviewer correctly identified a silent break: `stream-webhook.ts` resolves the target row only via `WHERE stream_video_id = ?` against the **`videos`** table. A clip gets a NEW uid that lives in `generated_assets` (or a dedicated clip-jobs row), not `videos`, so the existing handler returns `matched=0` and silently drops the ready event. Fix: after `createStreamClip`, we persist the clip uid in `generated_assets` (kind='video', source='video_gen' is wrong here — we add a clip-specific row with `stream_video_id`, `project_id`, `status='processing'`). We extend `stream-webhook.ts` with a fallback resolution path: when the `videos` UPDATE matches 0 rows, attempt to resolve `payload.uid` against `generated_assets.stream_video_id` and flip that row's status to `ready`/`failed` (mapped from `status.state`). The handler returns `matched` counting either table. Polling via `env.STREAM.video(uid).details()` remains a backstop.

**Multi-clip assembly via Remotion (Stream has no concat).** For a multi-clip timeline → one final video, we do NOT use Stream clipping. We pass the EDL as `compositionProps.clips[]` to a new `spooool-timeline` composition (`container/render/remotion/TimelineVideo.tsx`, modeled on `SpoooolExplainer.tsx`), selected via `compositionProps.compositionId`. **The container stays strictly R2-only** — its `render.ts` resolves clip paths via `downloadTake(r2Key, destPath)` exactly as it does for `takeKeys` and `audio.r2Key` today. It has no STREAM binding. Therefore **the Worker pre-stages every Stream-sourced clip to R2 before dispatch**: for each `sourceKind:'stream'` clip, the Worker calls `env.STREAM.video(uid).downloads.generate()`, then **polls `downloads.get()` / GET `/downloads` until `status === 'ready'`** (the generate call returns `status:'inprogress'` with `percentComplete`; the MP4 URL is NOT fetchable until ready — this was the reviewer's high-severity correction), fetches the ready MP4, writes it to a staging R2 key (`edit/staged/{uid}.mp4`, deduped by uid), and rewrites the clip's `sourceRef` to that R2 key with `sourceKind:'r2'` in the dispatched `compositionProps.clips[]`. The container then only ever sees R2 keys. `TimelineVideo` lays out sequential `<Sequence from={cumulative} durationInFrames={clip.outFrames-clip.inFrames}>` with `<OffthreadVideo src={staticFile(path)} trimBefore={clip.inFrames} trimAfter={clip.outFrames}>`, captions as overlay `<Sequence>` text, and transitions via `@remotion/transitions`. `calculateTimelineDuration` sums clip durations. The render re-enters `submitRenderJob({ userId, takeKeys: [], compositionProps: { compositionId: 'spooool-timeline', clips, title }, env })` and flows through the unchanged complete → encode → Stream path.

**Container dependency (corrected).** `@remotion/transitions` is NOT currently in `container/render/package.json` (verified: deps include animation-utils, bundler, captions, google-fonts, layout-utils, media-utils, renderer, shapes, studio, zod-types — no transitions). It is a hard build-time dependency for `TimelineVideo` transitions; the container image rebuild fails or renders incorrectly without it. We add `@remotion/transitions` (pinned to the same `^4.0.0` line as the other `@remotion/*` deps) before the image rebuild, and call it out in the manual-ops runbook.

**Media Transformations wins.** `src/workers/media-transform.ts` wraps the `MEDIA` binding (`env.MEDIA.input(r2obj.body).transform({width,height}).output({mode,time,duration,...}).response()`), preferred over `/cdn-cgi/media` to avoid the same-zone 404 quirk (the binding-vs-subrequest split mirrors the AI-gateway quirk). Helpers: auto-poster (`mode:'frame'`), social crop (`mode:'video', fit:'cover'`), preview GIF/spritesheet (`mode:'spritesheet', imageCount`), trim-to-share (`mode:'video', time, duration`), and audio extraction (`mode:'audio'`) for the captions path. Use `fit:'cover'` (documented; `crop` is an undocumented alias). Source must be H.264/AAC MP4 in R2 ≤100MB/≤10min; non-conforming originals are skipped or normalized via the Stream encode path first. Billing is per output-second for video/audio — guard durations.

## E11 design — AI Studio

**Chat surface.** `/studio` mounts `AIStudio` (lazy route), using `@tanstack/ai-react` `useChat({ connection: fetchServerSentEvents('/api/studio/chat') })`. The server route (`studio.ts`) calls `chat({ adapter: gatewayChat(env), messages, tools })` and returns `toServerSentEventsResponse(stream)`. `chat()` is itself the agent loop, a direct replacement for the bespoke manual loop. Model selection is gated server-side (client body `model` is ignored).

**Image gen** (thumbnails + b-roll): `generateImage({ adapter: gatewayImage(env, '@cf/...') })` returns `images[0].b64Json`; we base64-decode, `VIDEOS.put`, set `generated_assets.bytes`/`videos.bytes` for quota, `hasRoomFor` precheck. **Video b-roll**: `env.AI.run('google/veo-3.1', input, { gateway: { id: 'x' } })` from the `AI_GEN` queue consumer (binding call, NOT compat fetch) → `result.video` URL → `env.STREAM.upload(videoUrl)` or stage to R2. **TTS**: `generateSpeech({ adapter: gatewayTts(env) })` returns base64 `audio` — note the extra base64-decode hop vs the current raw binding call in `synthesizeTts` (today's `env.AI.run` returns raw bytes; the adapter wraps them base64). This decode is integration-tested against a real adapter instance (mock `env.AI.run` at the boundary, returning known bytes, then assert `result.audio` decodes to those exact bytes) to catch double-encode. **Transcription/captions**: `generateTranscription({ adapter: gatewayTranscription(env) })` returns `{ text, segments }`, mapped into the E10 `CaptionCue[]` track. **AI metadata**: a non-streaming `chat({ stream:false, outputSchema })` produces `{title, description, tags[], chapters[]}`.

**create-tools.ts refactor.** `draftScript`/`planScenes` swap their internal `chatComplete` for `chat({ adapter: gatewayChat(env), messages, stream:false })` (planScenes uses `outputSchema` for the scenes JSON, removing the hand-rolled parse-or-retry). `synthesizeTts` swaps `env.AI.run('@cf/deepgram/aura-2-en', ...)` for `generateSpeech({ adapter: gatewayTts(env) })`, base64-decoding before `VIDEOS.put` to `recorder/tts/{jobId}.mp3`. **The refactor MUST preserve gateway observability** — `gatewayChat`/`gatewayTts` default to a gateway-routed mode (not plain `{ binding: env.AI }`), so the calls remain visible in gateway 'x' exactly as today. Public signatures (`draftScript`, `planScenes`, `synthesizeTts`, `finalizeRender`), `SceneSpec`, and caps (script ≤1500, scenes ≤20, tts ≤2000) are preserved so `composer-agent-do.ts` stages are untouched. The default text model stays `@cf/google/gemma-4-26b-a4b-it` for output parity.

## Data flow

1. **Edit (timeline)**: browser builds EDL → `POST /api/edit/projects` (persist) → `POST /api/edit/render` → Worker pre-stages every Stream clip to R2 (downloads.generate + poll-until-ready + fetch + R2.put, deduped by uid) and rewrites clips to R2 refs → `submitRenderJob(compositionProps.clips)` → container resolves R2 keys, stitches, uploads → `/complete` → `videos` row + encode + Stream.
2. **Clip share**: `POST /api/edit/clip` → `stream-clip.ts` REST → persist clip uid on `generated_assets` → ready via extended `stream-webhook.ts` (videos OR generated_assets) or `details()` poll → return clip uid.
3. **Studio gen**: chat SSE inline; image/tts synchronous to R2; video enqueued to `AI_GEN` → consumer runs the Veo binding call → `result.video` → Stream upload / R2 → `generated_assets` row.
4. **Cost**: every gen/edit op writes an `ai_costs` ledger row; `costs.ts` aggregates it into the snapshot.

## Schema / migrations

New migration `0022_edit_and_ai_studio.sql` (mirrors 0020/0021 conventions: `user(id)` FKs, INTEGER ms timestamps, stuck-sweep indexes):

- `edit_projects(id PK, user_id REFERENCES user(id), source_video_id TEXT REFERENCES videos(id) ON DELETE SET NULL, title, edl_json TEXT NOT NULL DEFAULT '[]', status CHECK('draft','rendering','completed','failed'), render_job_id REFERENCES render_jobs(id), created_at INTEGER, updated_at INTEGER)` + idx `(user_id, status)`, `(status, updated_at)` for a stuck-sweep. **`source_video_id` is an explicit FK with `ON DELETE SET NULL`** (reviewer correction — avoids orphan references when a source video is deleted; the column was previously a bare TEXT).
- `generated_assets(id PK, user_id REFERENCES user(id), kind CHECK('image','video','audio','caption','metadata','clip'), source CHECK('image_gen','video_gen','audio_gen','stt_gen','text_gen','stream_clip'), r2_key, stream_video_id, bytes INTEGER NOT NULL DEFAULT 0, status CHECK('queued','processing','ready','failed'), spec_json TEXT, error_message, project_id REFERENCES edit_projects(id), created_at INTEGER, updated_at INTEGER)` + idx `(user_id, kind)`, `(stream_video_id)` (the new index lets `stream-webhook.ts` resolve clip ready events efficiently). `kind='clip'`/`source='stream_clip'` hold Stream-clip rows so the webhook can find them.
- `ai_costs(id PK, user_id REFERENCES user(id), op CHECK(...), route TEXT, model TEXT, units REAL, unit_kind CHECK('tokens','seconds','images','characters'), est_usd REAL, project_id, created_at INTEGER)` + idx `(user_id, created_at)`.
- ALTER `videos ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0` and `ADD COLUMN source_video_id TEXT` to tag edited/AI outputs. (`videos.source_video_id` stays a bare TEXT — videos is the canonical table and a self-FK with cascade semantics is out of scope; documented as intentionally non-FK.)

No change to `video-status.ts` alphabet; edited/generated videos reuse `queued→encoding→ready`. `transitionVideoStatus` is reused for any status writes.

## Wrangler additions

- `[media]` binding `= "MEDIA"` (dedicated media service) for Media Transformations.
- `[[queues.producers]]` `AI_GEN` + register its consumer; the `async queue` handler in `index.ts` branches by message body (mirroring how `handleEncodingMessage` consumes `VIDEO_ENCODING`) to `handleAiGenMessage`.
- New DO is NOT required; editor renders reuse `RENDER_CONTAINER`. Container image version must bump (new `TimelineVideo` composition + `@remotion/transitions` dep; the container stays R2-only so NO Stream-resolution code is added there).
- New secrets already present (`CF_STREAM_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_STREAM_WEBHOOK_SECRET`). Note: the gateway id used in code is `'x'` (per `create-tools.ts`), even though the `[ai]` block comment historically referenced `'spooool'`. Add `AI_GATEWAY_MODE` var (default `gateway-binding`).
- Mount new routers in `index.ts`: `app.route('/', editRoutes)`, `app.route('/', studioRoutes)`; fold their Env into the `EnvBindings` intersection (currently `AuthEnv & VideoRoutesEnv & RenderEnv & CreateEnv & StreamUploadEnv & {...}`).

## Error handling

- Stream clip 200 ≠ ready: treat as async (`readyToStream:false`, `size:0`); poll/webhook. Surface `failed` if `status.state==='error'`. Webhook resolves clip uid in `generated_assets` when not found in `videos`.
- Stream→R2 prestage: bounded poll on `downloads.get()` (e.g. ≤90s, backoff); on timeout or `status:'error'`, fail the render job with a clear message; `runStuckJobSweep` (>15min) is the backstop. Never fetch the MP4 URL before `status==='ready'`.
- Container clip resolution: container only sees R2 keys; a missing key fails the job loudly.
- Video gen: the Veo binding call can be slow; the `AI_GEN` consumer bounds total time and on failure marks `generated_assets.status='failed'`. Queue retries per consumer config.
- TTS/image base64 decode failures → typed errors; content-policy refusals reuse the existing `isContentPolicyMsg` rephrase message.
- All AI failures keep the existing retry/backoff shape in `create-tools.ts`.

## Cost / abuse guards

- Reuse `CREATE_BUCKET` pattern (in `rate-limit.ts`); add `EDIT_BUCKET` (e.g. 10 renders/hr) and `STUDIO_GEN_BUCKET` (e.g. 20 gen ops/hr) via `RATE_LIMITER` + `rateLimit`/`rateLimitHeaders`.
- `emailVerified` gate on every mutating route (defense-in-depth, mirroring `create.ts`: 401 unauth, 403 unverified, 429 rate-limited).
- Per-op caps: max EDL clips (e.g. 30), max clip duration, max video-gen seconds/day per user, read from user tier (Polar-backed).
- `ai_costs` ledger + `costs.ts` aggregation (extend `CostSnapshot` with an `ai_spend` field, `getCostSnapshot` SUMs `ai_costs.est_usd`, `evaluateAlerts` adds reason `ai_spend_threshold`, `buildCostAlertProps` + `GET /api/admin/costs` expose it).
- Storage: every R2 write sets `videos.bytes`/`generated_assets.bytes` and prechecks `hasRoomFor` (`storage-quota.ts`) exactly like `videos.ts`.

## Testing

- Unit (vitest, colocated `*.test.ts`): `ai-gateway.ts` adapter wiring (mock `env.AI.run` at the boundary, assert model id AND `gateway:{id:'x'}` / cf-aig headers are threaded in the active mode), `create-tools.ts` refactor parity, `stream-clip.ts` REST body shape, `media-transform.ts` option strings, EDL→compositionProps mapping incl. Stream→R2 prestage rewrite, `ai_costs` math, `stream-webhook.ts` clip-uid resolution branch.
- **TTS adapter integration test (reviewer correction):** instantiate a real `@cloudflare/tanstack-ai` `createWorkersAiTts` adapter with a mock `env.AI` that `run()`-returns known raw bytes; assert `generateSpeech` `result.audio` base64-decodes back to those exact bytes (catches the double-encode hazard). Do NOT mock the adapter itself for this test.
- DOM (`*.dom.test.tsx`, happy-dom): TimelineEditor trim/split/reorder reducer, caption editor, `useChat` SSE consumption with a fake stream.
- Container: `TimelineVideo` `calculateTimelineDuration` sum; transitions render with `@remotion/transitions` present.
- Stream-prestage: poll-until-ready logic (mock `downloads.generate` returning `inprogress` then `ready`).
- e2e (Playwright, env-gated): `/studio` chat round-trip + image gen; `/edit/:id` render-to-watch happy path. Gated behind flags so CI stays green without live gateway/Stream.
- `lint:no-providers` must pass after the refactor — add a CI assertion.

## Sequencing

1. E11 foundation: add deps, `ai-gateway.ts` (gateway-routed default), refactor `create-tools.ts` (lowest-risk, proves the transport keeps observability).
2. E10 foundation: `0022` migration (with FKs + `generated_assets(stream_video_id)` idx), `stream-clip.ts` + clip-row persistence, `stream-webhook.ts` clip-resolution extension, `edit.ts` routes, `media-transform.ts`.
3. E10 container: `@remotion/transitions` dep, `TimelineVideo` + image bump (container stays R2-only).
4. E10 render: Stream→R2 prestage (downloads.generate + poll) + `POST /api/edit/render`.
5. E10 UI: lazy `/edit` route, EDL editor, captions, transitions, MT helper UIs.
6. E11 surfaces: `/studio` chat, image gen, captions feed into E10, AI metadata.
7. E11 video b-roll consumer (`AI_GEN` queue + Veo binding call).
8. Cross-cutting: `ai_costs` ledger, caps/rate limits, devtools, tests.

## Risks

- `env.AI.gateway('x')` behavior for non-chat activities on this account (mitigated by `AI_GATEWAY_MODE` + the `run-gateway` parity fallback). We never fall back to plain `{ binding: env.AI }` (observability loss).
- `@cloudflare/tanstack-ai` maintenance/version drift (pin + smoke test).
- Stream download→R2 prestage cost/latency for timeline renders (dedupe by uid; cache staged MP4s; bounded poll).
- Media Transformations beta gating per zone; non-H.264 R2 originals fail silently.
- Veo/MiniMax proxied-model availability + BYOK health on gateway 'x'; cost per video-second.
- Webhook double-handling: ensure the clip-resolution path is idempotent (status-machine guard) so retries don't thrash.

## Manual ops

- Enable Media Transformations on the spooool zone; ensure R2 public origin supports HEAD + range (Content-Range).
- Configure/verify the `MEDIA` service binding.
- Add `@remotion/transitions` to `container/render/package.json`, then rebuild + push the render container image (`npx wrangler containers build container/render --tag spooool-render:<ver> --push`) and bump the tag in `wrangler.toml`.
- Confirm a proxied text-to-video model (`google/veo-3.1` or MiniMax Hailuo) is enabled on gateway 'x' with a healthy BYOK key; confirm `env.AI.run(<video-model>, …, { gateway: { id: 'x' } })` returns `result.video`.
- Verify `AI_GATEWAY_MODE=gateway-binding` works for chat/image/tts/transcription on this account before launch; if any activity misbehaves, flip to `run-gateway`.
- Configure the Stream ready-notification webhook (already wired via `stream-webhook.ts`) and confirm it fires for clips.


---

## Appendix A — Linear epics & issues

Filed in Linear project **Spooool** (team Aloe). Epics: **ALO-624 (E10 — Native Editing)**, **ALO-625 (E11 — AI Studio)**. Dependencies are encoded as Linear `blockedBy` relations.

| Issue | Epic | Pts | Pri | Title |
|---|---|---|---|---|
| ALO-626 | E10 | 3 | P1 | Add 0022 migration: edit_projects (+source FK), generated_assets (+stream_video_id idx), ai_costs, video columns |
| ALO-627 | E10 | 2 | P2 | Add EDIT_BUCKET rate-limit bucket and editor abuse guards |
| ALO-628 | E10 | 5 | P1 | Stream Clipping API wrapper + clip-row persistence + POST /api/edit/clip |
| ALO-629 | E10 | 3 | P1 | Extend stream-webhook.ts to resolve clip ready events on generated_assets |
| ALO-630 | E10 | 5 | P1 | Add edit-project CRUD routes + EDL model and validation |
| ALO-631 | E10 | 1 | P1 | Add @remotion/transitions to container/render/package.json |
| ALO-632 | E10 | 3 | P2 | Add Media Transformations helper module via MEDIA binding + wrangler [media] |
| ALO-633 | E10 | 5 | P2 | Add Media Transformations endpoints (auto-poster, social crop, preview, trim-to-share) |
| ALO-634 | E10 | 5 | P1 | Add spooool-timeline Remotion composition + calculateTimelineDuration |
| ALO-635 | E10 | 5 | P2 | Add Worker-side Stream→R2 prestage (downloads.generate + poll-until-ready) + image bump |
| ALO-636 | E10 | 5 | P1 | Add POST /api/edit/render — EDL → prestage Stream sources → submitRenderJob |
| ALO-637 | E10 | 8 | P1 | Build browser timeline editor route + EDL reducer (trim/split/reorder) |
| ALO-638 | E10 | 5 | P2 | Add caption/subtitle track editor |
| ALO-639 | E10 | 3 | P3 | Add transition picker UI + EDL wiring |
| ALO-640 | E10 | 3 | P2 | Add editor render status/progress + cost surfacing |
| ALO-641 | E10 | 3 | P2 | Add E10 tests + manual-ops runbook (MT enablement, R2 origin, @remotion/transitions, image bump) |
| ALO-642 | E11 | 5 | P1 | Add @tanstack/ai deps and build ai-gateway.ts transport (gateway-routed default, observability preserved) |
| ALO-643 | E11 | 5 | P1 | Refactor create-tools.ts onto @tanstack/ai with output + observability parity |
| ALO-644 | E11 | 5 | P2 | Add AI Studio chat route with SSE streaming + studio.ts router |
| ALO-645 | E11 | 5 | P2 | Build AI Studio chat UI at /studio with useChat + SSE |
| ALO-646 | E11 | 5 | P2 | Add image generation endpoint + thumbnail/b-roll UI |
| ALO-647 | E11 | 8 | P3 | Add AI_GEN queue + generative video b-roll consumer via env.AI.run('google/veo-3.1', {gateway}) |
| ALO-648 | E11 | 5 | P3 | Add auto-captions/transcription endpoint feeding the E10 caption track |
| ALO-649 | E11 | 3 | P3 | Add AI metadata generation (title/description/tags/chapters) |
| ALO-650 | E11 | 5 | P2 | Add ai_costs ledger aggregation, generation caps, and STUDIO_GEN_BUCKET |
| ALO-651 | E11 | 2 | P4 | Wire TanStack AI devtools + gateway observability metadata |
| ALO-652 | E11 | 3 | P2 | Add E11 tests (incl. real-adapter TTS base64 integration test) + lint:no-providers CI assertion |

_Total: 27 issues, 115 points._

## Appendix B — Open questions to resolve during build

1. @cloudflare/tanstack-ai package — confirm current published version, maintenance status, and that createWorkersAiChat/Image/Tts/Transcription/Summarize exist as described, AND verify that { binding: env.AI.gateway('x') } (gateway-binding mode) actually emits cf-aig observability/cache headers for concrete @cf/ models on this account before pinning. It is a companion package in cloudflare/ai, not a @tanstack/ai-* adapter.
2. AI_GATEWAY_MODE default: gateway-binding ({ binding: env.AI.gateway('x') }) vs run-gateway (custom wrapper calling env.AI.run('@cf/..', input, { gateway: { id: 'x' } }), byte-for-byte parity with today's create-tools.ts). The design defaults to gateway-binding but never to plain { binding: env.AI } (which the reviewer confirmed drops observability). Confirm gateway-binding passes a live smoke test per activity (chat/image/tts/transcription); if any activity misbehaves, ship run-gateway.
3. Generative video b-roll model: confirm google/veo-3.1 (or a MiniMax Hailuo proxied model) is enabled on gateway 'x' with a healthy BYOK key, and confirm env.AI.run('google/veo-3.1', input, { gateway: { id: 'x' } }) returns { result: { video: <url> }, state: 'Completed' } from inside a Worker (the CF changelog shows exactly this). Document the exact field names and whether long jobs need async polling vs the synchronous result.video.
4. Media Transformations beta gating: confirm the feature is enabled on the spooool zone and the dedicated MEDIA service binding is available/configured; confirm whether R2 public (pub-*.r2.dev or custom domain) origins answer HEAD + range (Content-Range) so the binding's input() byte-stream path works, and that private originals are driven only via the binding.
5. Stream→R2 prestage latency/cost for timeline renders: downloads.generate() returns status:'inprogress' (verified) and must be polled via downloads.get() until 'ready' before the MP4 URL is fetchable. Confirm the typical ready latency for short clips and set the prestage poll timeout (proposed ~90s) and dedupe-by-uid caching accordingly.
6. Current Workers AI model ids on this account: confirm the image model to pin (flux-2-klein-9b vs stable-diffusion-xl-base-1.0) and that @cf/openai/whisper-large-v3-turbo + @cf/deepgram/aura-2-en are current (gemma-4-26b-a4b-it is verified present/Hosted).
7. Default chat model: keep @cf/google/gemma-4-26b-a4b-it for create-tools.ts output parity during the refactor (the design keeps it), or swap to @cf/openai/gpt-oss-120b? The swap is deferred — confirm whether the swap is desired and, if so, validate output parity separately.
8. Polar tier → generation-cap mapping: what per-tier daily/hourly limits should gate image/video/audio generation and editor renders (EDIT_BUCKET / STUDIO_GEN_BUCKET defaults are placeholders)?

## Provenance

Design synthesized + adversarially verified via a multi-agent workflow (10 agents) on 2026-06-02. The reviewer caught and corrected: (1) a silent AI-Gateway observability regression in the naive `{ binding: env.AI }` path; (2) the missing `@remotion/transitions` container dep; (3) `stream-webhook.ts` dropping clip-ready events; (4) the Stream→R2 prestage `downloads.generate` poll-until-ready requirement; (5) the queue-consumer-is-a-Worker (CF-2019) correction for generative video.
