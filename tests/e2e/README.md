# Playwright E2E (ALO-173)

Critical-path browser tests that exercise the deployed app from the outside. They live here (not under `src/`) because they're not part of the worker/frontend bundles, and they're the only tests that need a real running app.

## Running locally

```sh
# One-time: install browser binaries
npx playwright install chromium webkit

# Start the app + run all tests (auto-starts `npm run dev` if no app is up)
npm run test:e2e

# Interactive runner — shows the browser, lets you step
npm run test:e2e:ui

# Just one file
npx playwright test tests/e2e/home.spec.ts
```

The Playwright config (`playwright.config.ts` at the repo root) defaults to `http://localhost:5173`. Set `PLAYWRIGHT_BASE_URL` to point at any other environment:

```sh
PLAYWRIGHT_BASE_URL=https://spooool-preview.workers.dev npm run test:e2e
```

When `PLAYWRIGHT_BASE_URL` is set, the bundled `webServer` is **skipped** so you don't double-start.

## What we cover

| File | Surface | Why |
|---|---|---|
| `home.spec.ts` | SPA shell + trending API | Fastest signal that the worker + assets are wired |
| `auth.spec.ts` | Signup → home; bad-credentials login | Exercises better-auth + lifecycle plumbing (ALO-143) |
| `api-health.spec.ts` | `/api/health`, `/robots.txt`, `/sitemap.xml` | Worker-served endpoints that are safe in any env |

The flows on the parent ticket (signup → upload → encode → watch → like → subscribe) are intentionally **deferred** until ALO-190 ships a staging environment with seeded fixture data. Today's tests run against any environment without writing to it (besides the throwaway signup users).

## Test hygiene

- **Shared environment safe**: tests can't assume an empty DB. They generate UUID-suffixed signup emails so reruns don't collide; they prefer existence checks over count-equals assertions on shared data.
- **Idempotent**: every test should pass when re-run on the same environment without manual cleanup.
- **No fixture data created they don't own**: anything written (signup users, uploads in future) gets a `e2e+` prefix or `e2e-` suffix so cleanup scripts can find them.

## CI

Not yet wired into the standard CI workflow — Playwright + browser binaries add ~2 min to every PR. The plan is a separate `e2e.yml` workflow that runs against the staging deployment after merges to `main` (filed as part of ALO-190 staging provisioning). For now, run locally before opening anything that touches the auth, watch, or upload flows.
