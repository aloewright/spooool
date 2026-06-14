# studio/ — the content hub

The writing studio (books, blogs, scripts), formerly the standalone
[`book-cook`](https://github.com/aloewright/book-cook) repo (now archived).
Serves as the content hub at **spooool.com/studio** and, during deprecation,
at book-cook.com (root mount). See
`docs/superpowers/specs/studio-content-hub.md` for the architecture and the
Phase 2 plan (AI Studio absorption).

## Layout

Self-contained **pnpm** workspace (`pnpm@9.15.0` via corepack) — independent
of the repo root's npm setup. Deployed as the `editor` Cloudflare Worker
(Hono API + React 19 / TanStack Router SPA, D1 + KV + R2 + Durable Objects +
Workflows + render container).

```
apps/web                # the worker + SPA
services/render-worker  # EPUB/PDF/audio render container
tests/unit              # node vitest (run from studio/)
tests/integration       # workers-pool vitest (run from apps/web)
```

## Commands (from `studio/`)

```sh
pnpm install
pnpm --filter web cf-typegen    # generate worker-configuration.d.ts (needed before typecheck)
pnpm typecheck
pnpm --filter web build
npx vitest run                  # unit
(cd apps/web && npx vitest run) # integration
```

CI: `.github/workflows/studio-ci.yml` (checks on `studio/**`),
`studio-deploy-prod.yml` (manual dispatch deploy of the `editor` worker).

## Mount architecture (the short version)

One build serves two bases: "/" (book-cook.com) and "/studio"
(spooool.com via zone route). The worker strips the prefix
(`apps/web/src/shared/app-base.ts`), rebases HTML asset URLs, and the client
detects its base at runtime. On the spooool mount, spooool's Better Auth
session is accepted directly (`SPOOOOL_DB` token lookup, email-mapped
auto-provisioning) and the `spooool` design tokens are the default theme.
Legacy `/words*` URLs 301 to `/studio*`.
