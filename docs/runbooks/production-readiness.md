# Production readiness checklist (ALO-126 / E7)

Single source of truth for "are we safe to open the doors?". Each row maps
a requirement from the E7 epic to the artifact that satisfies it. If a row
is unchecked, prod is not ready.

## Observability

- [x] Workers Logs enabled with sampled-2xx / always-errors policy — `wrangler.toml` `[observability.logs]`
- [x] Logpush sink to R2 — `scripts/setup-logpush.sh`, R2 binding `LOGS`
- [x] Analytics Engine for view + watch-time — `[[analytics_engine_datasets]]`, `src/workers/analytics.ts`
- [x] Sentry on the frontend — `@sentry/react`, init via `VITE_SENTRY_DSN`
- [x] Sentry on the worker — `@sentry/cloudflare`
- [x] PostHog product analytics — `posthog-js`, RUM via `src/workers/rum.ts`
- [x] `/api/health` liveness probe — `src/workers/health.ts`

## Rate limiting + abuse defenses

- [x] Durable Object rate limiter — `src/workers/rate-limit-do.ts`, `rate-limit.ts`
- [x] Buckets on auth, upload, search — wired in `src/workers/index.ts`
- [x] CSRF on auth — `src/workers/csrf.ts`
- [x] Security headers (CSP, HSTS, frame-ancestors) — `src/workers/security-headers.ts`
- [x] Signed R2 URLs for video delivery — `src/workers/videos.ts`, `video-range.ts`
- [x] Per-user storage quota with 413 — ALO-72, `src/workers/storage-quota.ts`
- [x] Spam filter on comments — `src/workers/spam-filter.ts`
- [x] AI Gateway guard — `scripts/check-no-direct-providers.mjs`, CI step

## DMCA + moderation

- [x] DMCA takedown endpoint — `src/workers/dmca.ts`
- [x] Moderation queue — `src/workers/moderation.ts`
- [x] Lifecycle state machine including `taken_down` — ALO-138, `src/workers/lifecycle.ts`

## CI/CD

- [x] PR CI — `.github/workflows/ci.yml` (lint · type-check · test · build)
- [x] Staging auto-deploy on `main` — `.github/workflows/deploy-staging.yml`
- [x] Production deploy gated on manual dispatch + staging smoke — `.github/workflows/deploy-prod.yml`
- [x] Doppler-backed secrets at deploy time — `scripts/sync-doppler-secrets.mjs`

## Tests

- [x] Unit tests — `npm test` (vitest)
- [x] E2E on critical paths — `tests/e2e/*.spec.ts` (Playwright; home, auth, API health)
- [x] Load tests — `tests/load/upload.k6.js`, `watch.k6.js` (1k watchers, 50 uploaders baseline)

## Operability

- [x] D1 backup + restore runbook — `docs/runbooks/d1-backup-restore.md` (RPO 30m / RTO 15m via Time Travel)
- [x] On-call runbook — `docs/runbooks/on-call.md`
- [x] Cost monitoring + alerts runbook — `docs/runbooks/cost-monitoring.md`

## Release gate

Production deploy is **blocked** unless:

1. CI is green on the target ref.
2. Staging is healthy (`/api/health` returns `status: ok`) — verified
   automatically by the `staging-smoke` job in `deploy-prod.yml`.
3. The deployer (manual `workflow_dispatch`) accepts responsibility for
   the change.

The intent is "staging mirrors prod" — when staging is broken, prod
deploy must wait until it isn't.
