# AI Studio Generative Video (AI_GEN queue) — ALO-647 Implementation Plan

> Use superpowers:subagent-driven-development. Grounded inline (queue handler, veo-3.1 API, Stream URL-ingestion, studio bindings).

**Goal:** Generate b-roll video from a prompt via Veo 3.1, off a queue. `POST /api/studio/video` enqueues `AI_GEN`; a consumer calls `env.AI.run('google/veo-3.1', …, { gateway: { id: 'x' } })`, stages the result to R2 + Stream, and records `generated_assets` + `ai_costs`.

**Depends on:** ALO-642 (gateway), ALO-626 (`0022` → `generated_assets`/`ai_costs`, merged here), ALO-644 (`studio.ts`). Stacked on `alo-646` (has `studio.ts` with `StudioEnv` DB+VIDEOS + the migration).

## Verified facts
- **Queue handler** (`index.ts:183-195`): `async queue(batch, env)` iterates `batch.messages` → `handleEncodingMessage`, ack/retry. Branch on `batch.queue` (encoding queue name is in wrangler.toml ~L80; the new one is `ai-gen`).
- **Veo:** `env.AI.run('google/veo-3.1', { prompt, duration, aspect_ratio, resolution, generate_audio }, { gateway: { id: 'x' } })` → `aiResponse.result.video` (a video URL). The queue consumer is still a Worker → use the binding call, NOT a compat fetch (CF-2019). `google/veo-3.1` is NOT a lint-forbidden id.
- **Stream ingestion:** reuse the `sendToStream` REST pattern from `encoding.ts` (`POST api.cloudflare.com/.../stream { url: 'r2://<key>' }` with `CF_STREAM_API_TOKEN`) → `stream_video_id`. The `STREAM` binding only exposes `createDirectUpload`.
- **wrangler:** `[[queues.producers]] binding = "VIDEO_ENCODING"` exists; add `binding = "AI_GEN", queue = "ai-gen"`. Consumers are registered server-side (manual ops) — note it.

## Tasks
1. **Consumer `src/workers/ai-video-consumer.ts`** — `handleAiGenMessage(env, body)`: `env.AI.run('google/veo-3.1', {prompt, duration, aspect_ratio, resolution, generate_audio}, {gateway:{id:'x'}})` → fetch `result.video` → `VIDEOS.put('studio/video/{assetId}.mp4')` (bytes) → best-effort `sendToStream('studio/video/{assetId}.mp4')` → `stream_video_id` → `UPDATE generated_assets SET status='ready', bytes=?, stream_video_id=?, updated_at=?` + INSERT `ai_costs` (`op='video_gen'`, `route='dynamic/video_gen'`, `unit_kind='seconds'`, `units=<duration>`). On failure → `status='failed'`, `error_message`. Colocated test.
2. **`POST /api/studio/video` in `studio.ts`** — gate copied from `/image` (401/403/429/400); INSERT `generated_assets` (kind='video', source='video_gen', status='queued', spec_json); `env.AI_GEN.send({ assetId, userId, prompt })`; return `202 { assetId }`. Add `AI_GEN: Queue<…>` to `StudioEnv`.
3. **`index.ts` queue branch** — `if (batch.queue === 'ai-gen') await handleAiGenMessage(env, message.body); else await handleEncodingMessage(...)`.
4. **wrangler.toml** — add the `AI_GEN` producer; runbook note to register the `ai-gen` consumer.
5. **Tests** — consumer (mock env.AI veo + fetch + R2 + DB + Stream REST: assert run args, R2 key, generated_assets UPDATE to ready + stream_video_id, ai_costs insert, failure→failed); endpoint (202 + enqueue + generated_assets queued row; 401/403/429/400).

## Acceptance criteria (ALO-647)
- [ ] `POST /api/studio/video` enqueues `AI_GEN` → 202 + assetId
- [ ] Consumer uses `env.AI.run('google/veo-3.1', …, {gateway:{id:'x'}})` — NO compat fetch
- [ ] `result.video` ingested (R2 staged with bytes; Stream best-effort) → status ready/failed
- [ ] `ai_costs` row written (`unit_kind='seconds'`)
- [ ] `lint:no-providers` green; inline comment on queue-consumer-is-a-Worker / CF-2019
