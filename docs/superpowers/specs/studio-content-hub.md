# Studio Content Hub

**Status**: Phase 1 in flight · Phase 2 approved in direction, pending detailed design
**Owner direction (verbatim)**: "integrate them together so that a user can either jump right into a project (upload a video or generate one) or plan one out (writing). it makes more sense for me to keep the aesthetic of the writing section and integrate/adopt the studio UI into it"

## What

`spooool.com/studio` becomes one content hub. The writing studio (books, blogs,
scripts — formerly the `book-cook` repo, now `studio/` in this repo) owns the
URL and the aesthetic; spooool's AI Studio capabilities (image, animation,
chat) are absorbed into it as the "jump right into a project" path.

## Architecture

- `studio/` is a **self-contained pnpm workspace** deployed as the existing
  `editor` Cloudflare Worker. It is deliberately NOT merged into the spooool
  Vite app: the stacks differ (React 19 + TanStack Router + pnpm vs
  React 18 + react-router + npm) and the worker carries its own D1/DO/
  Workflows/container bindings.
- Mounted at `spooool.com/studio` via a zone route (`spooool.com/studio*` →
  `editor`). The studio worker strips the `/studio` prefix before routing;
  the retired standalone domain is no longer routed to the worker.
- Same-origin superpower: on the spooool apex the hub calls **both** backends
  with the shared session cookie — its own API under `/studio/api/*` and
  spooool's under `/api/*` (different workers, one origin).
- Sessions: spooool's Better Auth cookie is accepted by the studio worker
  (token lookup via the `SPOOOOL_DB` binding, auto-provisioning by email).
  Signing in on spooool.com is signing in on the hub.
- spooool's client router hands `/studio` off with a full page load
  (`StudioHubRedirect` + hard nav link) so the zone route always wins.

## Phase 1 (this PR)

1. Import book-cook as `studio/` subtree; archive the old repo after verify.
2. Base prefix `/words` → `/studio`; legacy `/words*` 301s to `/studio*`.
3. Flatten the app's internal `/studio/...` routes to the root (pathless
   layout) so URLs read `spooool.com/studio/blogs/…`, not `/studio/studio/…`.
4. spooool nav "Studio" → hard link; its `/studio` client route → full-reload
   redirect. The legacy `Studio` page component stays in-tree for Phase 2.
5. CI: `studio-ci.yml` (checks on `studio/**`) + `studio-deploy-prod.yml`
   (manual dispatch, mirrors `deploy-prod.yml`, Doppler-sourced Cloudflare
   creds, deploys the `editor` worker).

## Phase 2 (follow-up PR(s))

1. **Hub home** becomes the content-hub entry: "Jump into a project"
   (Upload a video → spooool upload flow; Generate one → AI Studio) beside
   "Plan one out" (books / blogs / scripts as today).
2. **Port the AI Studio UI** (`src/frontend/studio/`: AIStudio, ImagePanel,
   AnimationPanel, chat) into the hub as routes (e.g. `/generate`), restyled
   to the writing section's token contract (`spooool` theme), calling the
   existing spooool endpoints (`POST /api/studio/animation`, image/chat
   equivalents) same-origin. Remotion rules apply to any animation code
   (`lint:remotion-animation`, frame-driven motion only).
3. Retire the legacy `src/frontend/studio/` route components once the ported
   surfaces reach parity; spooool keeps upload/watch/channel surfaces.

## Non-goals (for now)

- Merging user tables (sessions federate by email; two `user` tables remain).
- One worker / one framework. Coexistence via routes is the architecture.
- Renaming legacy persisted resource, cookie, and theme identifiers inherited
  from the standalone writing app.
