# Recorder pipeline smoke test

Manual checklist run after each deploy to validate `/record` works end-to-end.
The Playwright E2E in `tests/e2e/record.spec.ts` is the automated companion,
but it can't catch device-specific issues (camera orientation, mic levels,
WebCodecs availability per OS, screen-share permission flow) — that's what
this checklist is for.

> **Last smoke tested:** _fill in after each run._

## Pre-flight

- [ ] Last successful prod deploy is recent:
  ```sh
  gh run list --workflow=deploy-prod.yml --limit 1
  ```
- [ ] `RENDER_CALLBACK_SECRET` is set in worker secrets and the container shares
  the same value. Verify:
  - Worker: `npx wrangler secret list` shows `RENDER_CALLBACK_SECRET`.
  - Container uses the same secret — confirm via `wrangler secret list` and
    cross-check the value with the container's environment config. If they
    diverge, the container's callback `POST /api/render/callback` will 401 on
    every render attempt.
- [ ] Cloudflare dashboard shows the `RenderContainer` healthy: Workers &
  Pages → Containers → spooool / RenderContainer.
- [ ] `spooool-videos` R2 bucket is accessible:
  ```sh
  npx wrangler r2 object list spooool-videos --prefix recorder/raw/ --limit 5
  ```

## R2 lifecycle rule (one-time ops setup)

The recorder writes raw takes to
`recorder/raw/{userId}/{sessionId}/{takeId}.webm` in the `spooool-videos`
bucket. These are temporary scratch files — once rendering completes, the
takes are no longer needed. R2 lifecycle rules are not managed by
`wrangler.toml`, so this step must be done manually once per environment:

1. Cloudflare Dashboard → R2 → `spooool-videos` bucket → **Settings** →
   **Object lifecycle rules** → **Add rule**.
2. **Name:** `recorder-raw-7d`
3. **Prefix:** `recorder/raw/`
4. **Action:** Delete objects **7 days** after upload date.
5. Click **Save**. Verify the rule appears in the bucket settings list.

After it is live, check monthly that the rule is still configured — Cloudflare
occasionally prompts for reconfirmation after major settings changes.

To confirm the rule is working:

```sh
# List any recorder/raw objects older than 7 days — should be empty if the rule is active.
npx wrangler r2 object list spooool-videos --prefix recorder/raw/
```

## Happy path

- [ ] Sign in as a verified user (or sign up + verify a throwaway account).
- [ ] Navigate to `/record`.
- [ ] Grant camera and microphone permissions when the browser prompts.
- [ ] Record a 5-second talking-head take.
- [ ] Confirm the take appears in the take list UI after recording stops.
- [ ] Click **Create video** (the render submission button).
- [ ] Confirm the progress bar advances from 0 → 100%.
- [ ] Confirm the browser auto-navigates to `/watch/{videoId}` on completion.
- [ ] Confirm the rendered video plays end-to-end in the player.
- [ ] Confirm audio is in sync with video throughout.

## Failure surfaces (negative testing)

- [ ] **Deny camera permission** → expect an "Enable permissions" or similar
  inline message in the recorder UI. No crash, no blank screen.
- [ ] **Unsupported browser** — open `/record` in Safari (iOS or desktop) →
  expect the "Browser not supported" message with a link to `/upload` (the
  page guards on `'VideoEncoder' in window`; Safari does not expose WebCodecs).
- [ ] **Private / incognito window** — open `/record` in a private window →
  expect the "Security error" message from `EnsureBrowserSupport` (the Web FS
  API is blocked in private contexts).
- [ ] **Unverified account** — open `/record` on an account whose email has
  not been confirmed → expect the "Verify your email to record" gate.
- [ ] **Queue cap** — submit 4 renders in rapid succession for the same user →
  expect the 4th request to return `429` with `retryAfterSeconds: 60` (the
  in-memory `RenderQueue` caps at `queueMax: 3` active + pending).

## Container observability

- [ ] `wrangler tail spooool` shows render-related log lines when a render is
  triggered. Look for the container dispatch call and the callback receipt.
- [ ] After a successful render, the CF Containers dashboard shows the
  `RenderContainer` instance count drop back toward 0 within `sleep_after: 60s`
  of idle (configured in `wrangler.toml`).
- [ ] D1 query confirms the `render_jobs` state machine is healthy:
  ```sql
  SELECT status, COUNT(*) AS n
  FROM render_jobs
  WHERE created_at > unixepoch('now', '-1 hour') * 1000
  GROUP BY status;
  ```
  Expect `completed` rows. `queued` and `rendering` are transient — jobs stuck
  in either state for more than 15 minutes are swept to `failed` by the
  `sweepStuckJobs` cron (runs every minute via wrangler.toml).

  Run via:
  ```sh
  npx wrangler d1 execute spooool-prod --remote --command \
    "SELECT status, COUNT(*) AS n FROM render_jobs WHERE created_at > unixepoch('now', '-1 hour') * 1000 GROUP BY status"
  ```

## Cleanup verification

- [ ] After 7 days, `recorder/raw/<userId>/<sessionId>/` is empty in R2 (the
  lifecycle rule above handles this).
- [ ] Completed render output (`render_jobs.output_r2_key`) is accessible via
  `/watch/{videoId}` — the video is served from R2 via the `/api/videos/:id/stream`
  route once `videos.stream_video_id` is populated (or directly from R2 while
  encoding is still pending).

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser shows "Browser not supported" in Chrome | WebCodecs not available — possibly a corporate policy or older Chrome | Test with Chrome 94+ or Edge 94+; check `VideoEncoder in window` in the console |
| Render stuck in `queued` for > 15 min | Container failed to dispatch or `RENDER_CALLBACK_SECRET` mismatch causing 401 on callback | Check `wrangler tail` for `401` callback responses; re-sync the secret with `wrangler secret put RENDER_CALLBACK_SECRET` |
| Render swept to `failed` immediately | Container crashed mid-render (OOM, Chromium boot failure) | Check CF Containers logs; consider upgrading `instance_type` in `wrangler.toml` (currently `standard-3`) |
| Every render returns 429 | `RenderQueue` at capacity (3 slots); a prior render may have leaked an active slot | Wait for `sleep_after: 60s` to expire and the container to restart, or trigger a restart from the CF dashboard |
| Audio out of sync | Frame drops during recording; mediabunny re-mux dropped audio packets | Re-record. If reproducible, check `find-good-supported-codec.ts` output in the browser console (look for codec negotiation warnings) |
| Verify email never arrives | Cloudflare Email Sending domain not enabled, or SPF/DKIM misconfigured | See email provider notes in memory; current provider is Loops |
| `/record` loads then immediately redirects to sign-in | Session cookie not set cross-subdomain | Check `auth.pdx.software` route is attached to the spooool worker in CF dashboard |

## See also

- Playwright E2E: `tests/e2e/record.spec.ts`
- Render server queue logic: `container/render/src/server.ts` — `queueMax: 3`
- Stuck-job sweeper: `src/workers/render.ts` — `sweepStuckJobs`
- R2 raw-take path: `src/workers/videos.ts` — `recorder/raw/${user.id}/${sessionId}/${takeId}.webm`
- D1 backup runbook: `docs/runbooks/d1-backup-restore.md`
