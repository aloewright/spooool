# In-app Video Recorder + Render Pipeline (sub-project #1)

**Status**: Approved design, ready for implementation plan
**Date**: 2026-05-26
**Scope**: Sub-project #1 of the larger "Remotion Recorder + AI agents" initiative

## Context

spooool today is a video host where creators upload pre-recorded files via the chunked-upload flow at `/upload`. We want users to be able to **record and produce videos inside the app** — webcam + screen share, multi-take, server-side composition with intro/outro/branding. The Remotion Recorder template ([remotion-dev/recorder](https://github.com/remotion-dev/recorder)) gives us a strong starting point for the recording UX and Remotion gives us the composition primitives.

This spec covers sub-project #1: a working record-and-render pipeline with **deterministic** composition (fixed templates, parameterized title/brand). AI-driven composition, real-time coaching, and text-to-video are explicitly deferred to sub-projects #2, #3, and #4 and will be specced separately.

### Decomposition (for context)

| # | Sub-project | Depends on |
|---|---|---|
| 1 | **Record + Render pipeline** (this spec) | nothing |
| 2 | Composer agent — replace deterministic template with agent-generated composition spec | #1 |
| 3 | Coach agent — real-time WebSocket feedback during recording | #1 |
| 4 | Text-to-video flow — separate `/create` mode | #1, #2 |

## License note

Remotion Recorder is licensed; commercial entities may require a paid company license. See [Remotion's LICENSE](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md). Confirm spooool's licensing posture before merging.

## Approach

**A — Port the Remotion Recorder repo's recording UI patterns** into spooool's existing Vite + React app. The recorder is a Remotion template (not Next.js as initially assumed), so its `src/` (React recording UI) and `remotion/` (Remotion compositions) port cleanly into our codebase without framework translation. The container then runs `@remotion/renderer` against the `remotion/` folder to produce the final MP4.

Rejected alternatives:
- **B (build minimal from scratch)** — smaller, but loses the recorder's mature recording UX (scene management, WebCodecs capture quality, IndexedDB buffering). Net more work to recreate features.
- **C (sibling subdomain app)** — keeps the recorder unchanged but creates two codebases and breaks single-domain auth.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (spooool React app, /record page)                          │
│   src/frontend/recorder/* (ported from remotion-dev/recorder src/) │
│   ├── webcam + screen capture (WebCodecs)                          │
│   ├── IndexedDB take buffer                                        │
│   ├── scene/take management UI                                     │
│   └── composition preview (@remotion/player)                       │
│   1. PUT raw takes (chunked) → R2                                  │
│   2. POST composition spec → /api/render/jobs                      │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (existing spooool worker)                        │
│   /api/render/jobs       (new)  → create job, dispatch container   │
│   /api/render/jobs/:id   (new)  → poll status                      │
│   /api/render/jobs/:id/complete  (internal, shared-secret-auth)    │
│   /api/render/jobs/:id/fail      (internal, shared-secret-auth)    │
│   /api/render/jobs/:id/progress  (internal, shared-secret-auth)    │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ env.RENDER_CONTAINER.get(idFromUserId).fetch()
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ Cloudflare Container (new, per-account dispatch)                   │
│   Image: node:22-bookworm-slim + chromium + ffmpeg + Remotion @4   │
│   ├── POST /render { jobId, takeKeys, compositionProps }           │
│   ├── pulls takes from R2                                          │
│   ├── runs @remotion/renderer against bundled remotion/ project    │
│   ├── writes MP4 to R2 (recorder/renders/{jobId}.mp4)              │
│   └── callbacks to worker (progress, complete, fail)               │
│   sleepAfter: 60s  /  max 3 queued render jobs per instance        │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ Existing pipeline: VIDEO_ENCODING queue → Cloudflare Stream        │
│ → playable video in user's library  (no changes needed)            │
└────────────────────────────────────────────────────────────────────┘
```

Per-account isolation: `env.RENDER_CONTAINER.get(idFromUserId(userId))` derives a stable container instance ID from the user's ID, so each user's renders run in their own scale-to-zero instance.

## Components

### 1. Frontend — `/record` page + ported recorder UI

- **New route** `/record` mounted in `src/frontend/App.tsx`, gated on `useSession()` and `user.emailVerified`.
- **New folder** `src/frontend/recorder/` containing the ported recording UI components from `remotion-dev/recorder` `src/`. Adapted to Vite, React Router, and spooool's `auth-client`. No Next.js translation needed.
- **Composition preview** via `@remotion/player` embedded inline so users see the final composition before triggering render.
- **Raw-take upload** reuses the existing chunked-upload helper from `src/frontend/pages/Upload.tsx`; that helper is extracted into `src/frontend/lib/chunked-upload.ts` so both pages share one source of truth.
- **Browser support gating**: detect WebCodecs availability on mount; if absent, show a fallback message pointing to `/upload`.

### 2. Worker routes — `src/workers/render.ts` (new)

Mounted into the main Hono app in `src/workers/index.ts`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/render/jobs` | session | Body: `{ takeKeys, compositionProps }`. Insert `render_jobs` row, dispatch container, return `{ jobId }`. |
| GET | `/api/render/jobs/:id` | session (owner only) | Returns `{ status, progress, outputKey?, videoId?, error? }`. |
| POST | `/api/render/jobs/:id/complete` | shared-secret header | Container-only. Body: `{ outputKey }`. Creates `videos` row, enqueues into `VIDEO_ENCODING`, marks job completed. |
| POST | `/api/render/jobs/:id/fail` | shared-secret header | Container-only. Body: `{ error }`. Marks job failed. |
| POST | `/api/render/jobs/:id/progress` | shared-secret header | Container-only. Body: `{ progress: 0..100 }`. Updates progress for poll. |

Shared secret: `RENDER_CALLBACK_SECRET` set both on the worker and on the container service (different stores, same value).

### 3. CF Container — `container/render/` (new)

| File | Purpose |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim` base, install `chromium`, `ffmpeg`, `npm ci` deps, copy `remotion/` project, copy `server.ts`. Build target: ~600MB image. |
| `server.ts` | Hono server, port 8080. Routes: `POST /render` (queue-or-process), `GET /health`. Maintains in-memory queue (max 3 pending; returns 429 on overflow). |
| `render.ts` | Pulls takes from R2, runs `@remotion/renderer.renderMedia()` against the `remotion/` project bundled in the image. Streams `onProgress` callbacks back to worker every 5%. Uploads final MP4 to R2. |
| `remotion/` | Lifted from `remotion-dev/recorder` `remotion/`. Composition ID `spooool-video`. Parameterized props: `{ takes, title, brand, sceneOrder, layouts }`. |
| `package.json` | Container's own dependencies — separate from spooool's root `package.json`. |

`wrangler.toml` additions:
```toml
[[containers]]
class_name = "RenderContainer"
image = "./container/render/Dockerfile"
max_instances = 50
sleep_after = "60s"
default_port = 8080
instance_type = "standard-3"  # to verify against pricing
```

Worker binding name: `RENDER_CONTAINER`.

### 4. R2 layout — existing `VIDEOS` bucket

| Key prefix | Lifecycle |
|---|---|
| `recorder/raw/{userId}/{sessionId}/{takeId}.webm` | Auto-delete after 7 days (R2 lifecycle rule, new) |
| `recorder/renders/{jobId}.mp4` | Delete only after Stream ingest confirmed. If the existing pipeline already deletes source uploads from R2 after Stream ingest, the same path applies here. If not (to be verified — see Open items), add a 7-day R2 lifecycle rule on `recorder/renders/`. |

### 5. D1 schema — new migration `src/db/migrations/0020_render_jobs.sql`

```sql
CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','completed','failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  composition_spec TEXT NOT NULL,           -- JSON
  output_r2_key TEXT,
  video_id TEXT,                            -- FK to videos.id once enqueued
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_render_jobs_user_status ON render_jobs(user_id, status);
CREATE INDEX idx_render_jobs_stuck ON render_jobs(status, updated_at);
```

The `idx_render_jobs_stuck` index supports the stuck-render cron sweep below.

## Data flow

1. User opens `/record`. Browser prompts for camera, mic, and (if scene needs it) display-capture. `/api/auth/get-session` confirms verified user.
2. User records one or more takes per scene. WebCodecs encodes H.264 chunks in the browser; chunks are appended to an IndexedDB blob per take.
3. User clicks "Create video". Frontend:
   1. Calls the existing chunked-upload endpoint (currently used by `/upload`) for each take blob. The worker writes the chunks into R2 under `recorder/raw/{userId}/{sessionId}/{takeId}.webm` and returns the assembled R2 key. The recorder uses a `target: "recorder"` flag on the upload so the worker uses the new key prefix instead of the regular video-uploads prefix.
   2. POSTs `/api/render/jobs` with `{ takeKeys, compositionProps }`.
4. Worker creates a `render_jobs` row (status=queued), calls `env.RENDER_CONTAINER.get(idFromUserId(userId)).fetch("/render", { method: POST, body: { jobId, takeKeys, compositionProps } })`. Fire-and-forget; the worker returns `{ jobId }` immediately and does not block on the render.
5. Container:
   1. Sets `status='rendering'` via callback to the worker.
   2. Pulls each take from R2 to `/tmp/{takeId}.webm`.
   3. Spawns `@remotion/renderer.renderMedia()` against the bundled `remotion/` project with the user's composition props. Reports progress every 5%.
   4. Uploads final MP4 to R2 at `recorder/renders/{jobId}.mp4`.
   5. POSTs `/api/render/jobs/{id}/complete` with `{ outputKey }`.
6. Worker on `/complete`: creates a `videos` row pointing at the rendered MP4, enqueues `{ videoId }` into the existing `VIDEO_ENCODING` queue, marks the job completed with `video_id`.
7. Existing pipeline takes over: Cloudflare Stream encodes the MP4 and the video appears in the user's library. No new code needed.
8. Cleanup happens via the R2 lifecycle rules above.

**Client polling**: while the job runs, the frontend polls `GET /api/render/jobs/:id` every 2 seconds and shows a progress bar. On `status=completed`, it navigates to the new video's watch page using `video_id`.

**Concurrency per user**: one container instance per user means parallel render requests for the same user serialize. The container maintains an in-memory queue with a hard cap of 3 pending; further requests get HTTP 429 and the worker returns 429 to the client with `Retry-After: 60`.

## Error handling

| Layer | Failure | Behavior |
|---|---|---|
| Browser | Camera/mic permission denied | Block recording, point user to browser settings. No retry. |
| Browser | Display-capture cancelled | Offer "skip screen share" continuation. |
| Browser | WebCodecs unsupported | Detect on mount, show fallback link to `/upload`. |
| Browser | IndexedDB quota exceeded mid-take | Stop recording, surface error, prompt user to delete prior takes. |
| Browser | Upload chunk fails | Existing chunked-upload retry-with-backoff. |
| Worker | D1 insert fails | Return 500; client retry. Insert happens before container dispatch, so failure leaves no partial job. |
| Worker | Container dispatch throws | Mark job `failed` with `error_message='Container unavailable'`, return 503. |
| Worker | Job stuck in `rendering` >15 min | Cron sweep every 5 min marks stuck jobs `failed` with `error_message='Render timeout'`. |
| Container | R2 fetch fails (take missing) | POST `/fail` with reason; container exits cleanly. |
| Container | Remotion render crashes (OOM, bad codec, bad props) | Capture last 1KB of stderr, POST `/fail`. |
| Container | MP4 upload to R2 fails | Retry 3x with exponential backoff before failing. |
| Container | Worker callback fails | Retry 3x; if all fail, the MP4 stays in R2 and a daily orphan-finder cron reconciles R2 vs `render_jobs`. |
| Container | Queue overflow (>3 pending) | Return 429 to worker, worker returns 429 to client with `Retry-After: 60`. |

**New cron job** in `wrangler.toml` (add to existing `[triggers].crons` list): `*/5 * * * *` — every 5 minutes, mark `render_jobs` rows with `status='rendering' AND updated_at < now - 15min` as failed. Implemented in `src/workers/render.ts` as `runStuckJobSweep()`.

## Testing

| Layer | What | Location |
|---|---|---|
| Unit (worker) | Job CRUD, callback auth, owner-only access, stuck sweep | `src/workers/render.test.ts` |
| Unit (container) | Queue limit (max 3), retry logic, callback formatting; mock `@remotion/renderer` + R2 fetch | `container/render/server.test.ts` |
| Unit (frontend) | Scene/take state, permission gating, error surfaces; mock `navigator.mediaDevices` + IndexedDB | `src/frontend/recorder/*.test.tsx` |
| Integration (E2E) | Fake `getUserMedia`, record 2s of synthetic video, run end-to-end through to `status=completed` | `tests/e2e/record.spec.ts` (Playwright, CI-only) |
| Manual smoke | "Real device" checklist documenting things fake-getUserMedia can't catch | `docs/runbooks/recorder-smoke-test.md` |

Out of scope for this spec: load testing of CF Containers under burst, multi-region failover. Defer until sub-project #2 or later.

## Open items to verify during implementation

1. **License**: Remotion Recorder's terms for spooool's specific entity (personal? commercial? educational?).
2. **CF Containers pricing**: confirm `standard-3` instance type sizing and per-second cost against expected render durations. Re-pick `instance_type` if numbers don't work.
3. **CF Containers cold-start**: measure first-render latency from cold instance; if >30s, consider keeping a warm-up cron pinging `/health` every 5 min.
4. **R2 S3 API binding from container**: verify container can access R2 via S3-compatible API with scoped credentials; document credential setup.
5. **Stream MP4 ingest**: confirm the existing `VIDEO_ENCODING` queue + Stream pipeline accepts a finalized MP4 from R2 without changes (it does for uploads, expected to be the same path).

## Out of scope for this spec

- AI agents (composer, coach, text-to-video) — sub-projects #2, #3, #4.
- Editing UI beyond re-record (no trim, no reorder beyond what scene management already gives, no captions UI). The composer agent in #2 takes over this.
- Multi-language composition templates.
- Custom user-uploaded intro/outro assets — fixed templates in v1.
- Real-time collaboration on a recording session.
