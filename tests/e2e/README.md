# Playwright E2E (ALO-173 / ALO-E7)

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
PLAYWRIGHT_BASE_URL=https://spooool-staging.workers.dev npm run test:e2e
```

When `PLAYWRIGHT_BASE_URL` is set, the bundled `webServer` is **skipped** so you don't double-start.

## What we cover

| File | Surface | Why |
|---|---|---|
| `home.spec.ts` | SPA shell + trending feed | Fastest signal that the worker + assets are wired |
| `watch.spec.ts` | Video player, share button, resume banner | The single most-critical viewer journey |
| `auth.spec.ts` | Signup → home; bad-credentials login | Exercises better-auth + lifecycle plumbing |
| `upload.spec.ts` | Upload auth gate, form surface, 429 handling | Upload is the primary creator action |
| `search.spec.ts` | Search results, empty state, 429 handling | Primary content-discovery path for anonymous users |
| `comments.spec.ts` | Comment list, auth gate, post + appear | Core social feature on the watch page |
| `api-health.spec.ts` | `/api/health`, `/robots.txt`, `/sitemap.xml` | Worker-served endpoints safe in any env |
| `not-found.spec.ts` | SPA 404 view, home navigation | Pin the error surface; catch accidental 5xx |
| `record.spec.ts` | Record → upload → render → /watch | Full recorder pipeline (requires `E2E_RUN_RECORDER=1`) |
| `studio.spec.ts` | Studio shell | AI studio surface (requires `PLAYWRIGHT_STUDIO=1`) |

## Test hygiene

- **Shared environment safe**: tests can't assume an empty DB. They generate UUID-suffixed signup emails so reruns don't collide; they prefer existence checks over count-equals assertions on shared data.
- **Idempotent**: every test passes when re-run on the same environment without manual cleanup.
- **Stubbed APIs**: tests that exercise UI surfaces stub all worker API calls via `page.route` so they're isolated from D1 / R2 / Stream state. Only `auth.spec.ts` and `record.spec.ts` write real data (throwaway accounts + renders).
- **No fixture data they don't own**: anything written gets an `e2e+` email prefix so cleanup scripts can find it.

## CI

E2E tests run automatically against the staging deployment after every push to `main` via `.github/workflows/e2e-staging.yml`. The workflow triggers on `workflow_run: [Deploy · staging]` so it always tests the exact commit that was just deployed.

Run manually against staging any time before a production deploy:

```sh
gh workflow run e2e-staging.yml
```
