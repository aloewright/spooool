# Product analytics runbook (ALO-184)

> **Provider:** PostHog (cloud, EU region by default)
> **Code entry point:** `src/frontend/lib/analytics.ts`
> **Funnel events:** `src/frontend/lib/analytics.ts` → `ANALYTICS_EVENTS`

## What we capture

PostHog is the source of truth for product-level events — what users do
in the app, not what the worker serves. The signup → first upload →
first watch funnel is wired through the canonical event names below.

| Event                  | Where it fires                                        | Notable properties                                                       |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `signup_completed`     | After `signUp.email(...)` resolves on `/signup`       | `method` (currently always `email_password`)                             |
| `upload_started`       | When the user submits a valid file on `/upload`       | `file_size_bytes`, `file_type`                                           |
| `upload_completed`     | After all upload chunks return 2xx                    | `file_size_bytes`, `file_type`, `duration_ms`, `is_first_upload`         |
| `upload_failed`        | When any chunk POST throws or returns non-2xx         | `file_size_bytes`, `file_type`, `duration_ms`, `error` (truncated 200ch) |
| `video_play_started`   | First `play` event of a Watch mount (per video)       | `video_id`, `is_first_watch`                                             |
| `video_first_watch`    | The very first watched video for a browser profile    | `video_id`                                                               |

Filenames, video contents, comments, and any free-text input are **never**
sent. PostHog autocapture is on for clicks/pageviews, with input masking
in any session recording (`session_recording.maskAllInputs: true`).

## Privacy + EU posture

- Default ingest host: `https://eu.i.posthog.com` (overridable via
  `VITE_POSTHOG_HOST`). All anonymous-visitor traffic stays in the EU
  region unless an operator explicitly switches to US/self-hosted.
- `respect_dnt: true` — visitors with Do-Not-Track enabled get zero
  events, zero recordings, zero autocapture.
- Inputs masked in session recordings.
- "First-event" markers (`spool.fired.upload`, `spool.fired.watch`) are
  stored in `localStorage` so the funnel works for anonymous visitors
  too. Server-side actions (signing out, deleting an account) do **not**
  remove these browser-local markers — that's by design: the marker
  tracks the browser profile, not the server-side identity. Browser
  actions that wipe local storage (DevTools "Clear site data", clearing
  browsing data, switching profiles, incognito) **do** clear them, and a
  user in that state correctly counts as fresh.

## Building the funnel in PostHog

1. Project Settings → **Region** = EU.
2. **Insights → Funnels** → New funnel:
   1. `signup_completed`
   2. `upload_completed` (filter: `is_first_upload = true`)
   3. `video_first_watch`
3. Conversion window: 30 days. Step order: strict.

## Disabling analytics in an environment

- Leave `VITE_POSTHOG_KEY` unset in Doppler for that config. The frontend
  already gates `initAnalytics()` on the key, so the bundle ships with
  posthog-js but never makes a network call.
- For a single user, the simplest path is the browser DNT toggle.

## Adding a new event

1. Add a name to `ANALYTICS_EVENTS` in `src/frontend/lib/analytics.ts`.
2. Add a row to the table above.
3. Call `track(ANALYTICS_EVENTS.yourEvent, { ...props })` from the call
   site (lazy-import the module so PostHog stays out of the eager
   vendor chunk).
4. If the event is "first-of-its-kind", gate it on `isFirstEvent('key')`.
