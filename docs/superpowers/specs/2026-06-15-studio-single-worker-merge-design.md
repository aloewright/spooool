# Studio → spooool Single-Worker Merge

**Status**: Sub-project #1 (worker/backend consolidation) — design approved by owner ("one worker, one frontend, everything on TanStack"); owner delegated execution ("I don't care what you do… don't ask me anymore questions").
**Supersedes the direction in**: `docs/superpowers/specs/studio-content-hub.md` (which chose multi-worker coexistence via a zone route). The owner has overridden that: **one Cloudflare Worker, one frontend, unified on React 19 + TanStack Router.**

## Why

`spooool.com/studio` and `/words` broke the site: the studio content hub is a
*separate* `editor` worker (`bookgenerators-web`) meant to intercept
`spooool.com/studio*` via a zone route, but that route is not live in prod, so
the main worker's SPA fallback served `/studio` and the belt-and-suspenders
redirect looped forever. (Fixed independently on `main`, commit `db9f420`.)

The real goal is to stop running two workers entirely and fold the studio into
spooool as one deployable, one origin, one auth, one frontend.

## Decomposition (the whole merge)

Too large for one spec/plan. Five sequenced sub-projects, each its own
spec → plan → implement cycle:

1. **Worker/backend consolidation** ← *this spec*. Merge studio's Hono API,
   bindings, Durable Objects, Workflows, render container, and crons into the
   single spooool worker. Ships "one worker."
2. **Auth + data unification.** Collapse studio's Better Auth onto spooool's
   (both already use `better-auth`); decide D1 schema-merge vs two bound DBs.
3. **Frontend framework migration.** spooool's ~40 routes: React 18→19 +
   react-router→TanStack Router. Highest blast radius.
4. **Absorb studio's UI.** Mount studio's ~30 TanStack routes natively at
   `/studio/*` once #3 lands them on the same stack; restyle to spooool tokens.
5. **Tooling + cutover.** Unify npm/pnpm and the two Vite builds; single
   deploy; delete the `editor` worker, zone routes, `studio-deploy-prod.yml`;
   decide book-cook.com's fate.

Sequence: **1 → 2 → 3 → 4 → 5.**

---

## Sub-project #1 — Worker/backend consolidation

### Scope

**In:** one worker script that serves spooool's existing surface **plus**
studio's backend API (`/api/v1/*`), its agents endpoint (`/agents/*`), its 2
Durable Objects, 3 Workflows, render container, and weekly cron — all on
spooool's bindings. Type-checks, builds, and all existing tests pass.

**Out (later sub-projects):** the studio SPA / any frontend (#3, #4); full
Better-Auth cleanup beyond what the merge forces (#2); D1 schema merge (#2);
npm/pnpm unification of *frontend* deps and the dual Vite build (#5); deleting
the `editor` worker + zone routes (#5); production deploy (gated; manual
`Deploy·production` workflow, owner-run).

### Chosen approach — relocate the backend into spooool's tree

Of the options weighed (A compose-in-place, B relocate, C service-binding —
C rejected as still-two-workers), use **B (relocate)**. Reason: studio's
`env.ts` depends on the `CloudflareBindings` global emitted by
`wrangler types` into `worker-configuration.d.ts`, which the root tsconfig
(`include: ["src/**/*"]`, no studio typegen) does not see. Composing in place
would drag studio files into the root tsc program under the wrong config.
Relocating lets us give the backend a single explicit `Env` and compile it
cleanly under the root tsconfig — and it is the direction sub-projects #4/#5
go anyway.

The 53 studio backend `.ts` files are self-contained (no imports from the
studio `client/`), so the move is mechanical.

- `studio/apps/web/src/**` → `src/hub/**` (53 files).
- `studio/apps/web/drizzle/**` → `src/hub/drizzle/**` (8 D1 migrations for the
  studio DB).
- `src/hub/index.ts` is **demoted** from a worker entry to a module that
  exports: `hubRoutes` (a Hono sub-app), and the DO / Workflow / Container
  classes. The spooool entry (`src/workers/index.ts`) mounts and re-exports
  them. Its old `/api/auth/*`, `app.get('*')` ASSETS fallback, `/words` legacy
  redirect, and `stripAppBasePrefix`/`detectAppBase` prefix handling are
  **dropped** — there is no `/studio` prefix or second SPA in #1.

### Binding map

The studio binding names mostly do **not** collide with spooool's; only `DB`
does. `AI` is the same Workers AI binding and is shared.

| Studio (today)            | Merged worker            | Note |
|---------------------------|--------------------------|------|
| `DB` (D1 `bookgenerators`)| **`STUDIO_DB`**          | rebind existing DB; rename in code |
| `SPOOOOL_DB` (spooool-prod)| **`DB`**                | spooool-prod is the merged worker's primary DB |
| `KV`                      | `KV`                     | free in spooool (it uses `CACHE`, `SESSIONS`) |
| `R2` (`bookgenerators`)   | `R2`                     | free in spooool (it uses `VIDEOS`, `LOGS`) |
| `AI`                      | `AI`                     | shared (same Workers AI binding) |
| `ALOYSIUS` → `BookProjectAgent` | `ALOYSIUS`         | new DO class + migration tag |
| `RENDER_WORKER` → `RenderWorkerContainer` | `RENDER_WORKER` | new container DO + migration tag |
| `BOOK_EXPORT_WORKFLOW` …  | same                     | new `[[workflows]]` |
| `AUDIOBOOK_MASTERING_WORKFLOW` | same                | new `[[workflows]]` |
| `GTM_BRIEF_WORKFLOW`      | same                     | new `[[workflows]]` |

Code rename, applied per file (order-safe): `env.SPOOOOL_DB` → `env.DB`
**first**, then the remaining studio `env.DB` → `env.STUDIO_DB`.

`Secrets` studio expects (`BETTER_AUTH_SECRET`, `AI_GATEWAY_BASE_URL`,
`AI_GATEWAY_TOKEN`, `S3_*`, `RENDER_WORKER_INTERNAL_TOKEN`, `KEYRING_MASTER_KEY`,
`GOOGLE_CLIENT_*`) become part of the merged `Env`. They are provisioned as
worker secrets at deploy time (#5/owner); not needed for local type-check/build.

### Route composition (in `src/workers/index.ts`)

Mount after spooool's existing `/api/*` routes, before the OG/embed catch-alls:

```
app.route('/', hubRoutes)   // /api/v1/projects|blogs|scripts|chapters|voices|account|scout|compose|admin, /api/v1/health, /agents/*
```

`hubRoutes` keeps studio's `/api/v1/*` paths verbatim (no collision with
spooool's `/api/*`). The only collision — `/api/auth/*` — is resolved by
**not** mounting studio's auth; spooool's `/api/auth/*` is the sole auth.

### Auth boundary (minimal for #1; full cleanup is #2)

Studio routes authenticate via **spooool's session**. spooool's worker
middleware already resolves the session and `c.set('user', sessionUser)`.
Studio's `resolveSessionUser` is rewired to drop the studio-Better-Auth-first
branch and use `resolveSpoooolUser(env, headers)` against the merged bindings
(session read from `env.DB` = spooool-prod; studio user auto-provisioned by
email into `env.STUDIO_DB`). `requireUser` / `requireAdmin` keep their shape;
`requireAdmin`'s `is_admin` check runs against `STUDIO_DB`.

### Durable Objects / Workflows / Container / crons (`wrangler.toml`)

Add to the existing config:

```toml
[[durable_objects.bindings]]
name = "ALOYSIUS"
class_name = "BookProjectAgent"

[[durable_objects.bindings]]
name = "RENDER_WORKER"
class_name = "RenderWorkerContainer"

[[containers]]
class_name = "RenderWorkerContainer"
image = "./studio/services/render-worker/Dockerfile"   # build context preserved; verify CF container count limit
max_instances = 4
instance_type = "basic"

[[workflows]]
name = "book-export-workflow"
binding = "BOOK_EXPORT_WORKFLOW"
class_name = "BookExportWorkflow"
# + audiobook-mastering-workflow, gtm-brief-workflow

[[migrations]]
tag = "do_v6"
new_sqlite_classes = ["BookProjectAgent"]

[[migrations]]
tag = "do_v7"
new_sqlite_classes = ["RenderWorkerContainer"]

[[d1_databases]]
binding = "STUDIO_DB"
database_name = "bookgenerators"
database_id = "12308aa2-4101-4c20-8cce-fd0fd7a85a48"
migrations_dir = "src/hub/drizzle"

[[kv_namespaces]]
binding = "KV"
id = "550e0e2af0c9454c8e256d94fcac4d47"

[[r2_buckets]]
binding = "R2"
bucket_name = "bookgenerators"
```

Cron: add `"0 4 * * 1"` to `[triggers].crons` and route it in the worker's
`scheduled()` to `refreshMarketDataset(env)`.

`src/workers/index.ts` re-exports the new classes:
`export { BookProjectAgent, RenderWorkerContainer, BookExportWorkflow,
AudiobookMasteringWorkflow, GtmBriefWorkflow } from '../hub'`.

### Dependencies

Add to root `package.json` (all backend-only; frontend deps deferred to #3/#4):
`drizzle-orm`, `agents`, `ai`, `@ai-sdk/openai-compatible`,
`workers-ai-provider`, `@better-auth/core`. Bump `@cloudflare/workers-types`
to a recent version (studio uses `^4.20260430.1`) so `Workflow` / container DO
types resolve. Aligned already (no action): `zod` v4, `hono` 4.12,
`@sentry/cloudflare` 10, `@cloudflare/containers` 0.3, `better-auth` 1.6.

### tsconfig / build

Root tsconfig already `include`s `src/**/*`, so relocated `src/hub/**` is
covered. `skipLibCheck` is on, which absorbs dep-type noise. The worker build
is `wrangler` (esbuild) at deploy; local verification is `tsc --noEmit`,
`vite build` (frontend, unaffected), and vitest. The render container image is
only built at `wrangler deploy`, so it does not affect local verification.

### Testing

- Keep studio's backend unit tests; relocate the worker-relevant ones into the
  spooool vitest setup (`*.test.ts`) and fix import paths. Studio's
  workers-pool integration tests (`studio/tests/integration`) are adapted or
  deferred to the integration run.
- All **134 existing spooool frontend tests** and the workers tests must stay
  green.
- Add a smoke test asserting `hubRoutes` mounts and an unauthenticated
  `/api/v1/projects` returns 401 (Unauthorized) through the merged worker.

### Rollout (NOT in this session)

Deploy is gated (owner-run `Deploy·production`). Before first deploy:
1. Register the new DO migration tags and confirm `bookgenerators` D1 is bound.
2. Provision studio's secrets on the spooool worker.
3. The `editor` worker + `spooool.com/studio*` zone routes are removed in #5,
   not here — until #4 ships the studio UI, `/studio` keeps the in-app Studio
   fallback from `db9f420`.

### Verification checklist / risks

- **CF per-worker limits**: confirm one worker may carry 7 DO classes, 3
  container classes, 3 Workflows, 2 queues, 2 D1, 3 R2, 3 KV, and stays under
  the bundle-size cap. *Highest-risk unknown; verify first.*
- **Container count**: spooool already has 2 container classes
  (`RenderContainer`, `EncoderContainer`); adding `RenderWorkerContainer`
  makes 3. Verify CF allows ≥3 per worker; if not, the render container moves
  to a separate (allowed) mechanism or stays a bound service — revisit.
- **agents SDK**: `routeAgentRequest` + `BookProjectAgent extends Agent` must
  type-check under root tsconfig.
- **drizzle generated SQL**: `migrations_dir` points at relocated `src/hub/drizzle`.
- **DO data**: greenfield DO state per owner decision; only `bookgenerators`
  D1 content is preserved (rebind, no migration).

---

## Outline — sub-projects #2–#5 (for later specs)

- **#2 Auth+data**: remove studio `auth.ts`/`createAuth`; everything on
  spooool Better Auth; decide whether to merge studio's `users`/content tables
  into spooool-prod or keep `STUDIO_DB` bound. Federation-by-email becomes a
  single user identity.
- **#3 Frontend → React 19 + TanStack Router**: dependency-compat sign-off
  (Mantine 7, Radix, `@cloudflare/stream-react`, Remotion, Sentry, PostHog),
  router rewrite of spooool's ~40 routes, React 18→19 codemods.
- **#4 Absorb studio UI**: mount studio's TanStack routes at `/studio/*`,
  restyle to spooool tokens, retire the in-app legacy Studio fallback.
- **#5 Tooling + cutover**: one package manager + one Vite build + one `dist`;
  delete `editor` worker, zone routes, `studio-*.yml`; book-cook.com decision.
