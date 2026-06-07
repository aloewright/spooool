# Unified Cross-Web Video Search (Discover) — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)
**Phase:** 2 of 3 in the "Cobalt-powered feed" initiative

## Context

The spooool feed (`src/workers/feeds.ts`, `src/frontend/pages/FeedView.tsx`)
currently aggregates read-only items from a fixed set of source kinds
(spooool channels, YouTube channels/playlists/search, TikTok videos),
normalizing everything to a shared `FeedItem` (`src/workers/feed-item.ts`).
Only YouTube items embed inline; everything else links out.

This phase adds **unified video search across the web**: a user types a query
and gets deduped results aggregated from multiple providers, normalized to the
existing `FeedItem` schema. It is the first slice of a 3-phase initiative:

- **Phase 1 (deferred):** Cobalt action layer — inline-play / import-to-spooool /
  download on any feed item via the user's Cobalt instance.
- **Phase 2 (this doc):** Unified discovery/search.
- **Phase 3 (deferred):** Trends surface (incl. Google Trends / pytrends).

## Goals

- One search query → aggregated, deduped results across multiple providers.
- Results normalized to the existing `FeedItem` schema and rendered with the
  existing `FeedItemCard`.
- Two consuming surfaces: a dedicated `/discover` page, and a saveable
  `web_search` feed-source kind.
- Provider failures are isolated and surfaced per-provider, never blanking the page.

## Non-Goals (explicitly deferred)

- Cobalt inline-play / import / download (Phase 1).
- Trends / "what's hot" surfaces, pytrends, Metagraph API (Phase 3).
- Invidious provider (dropped: cannot run on Cloudflare Workers; YouTube API +
  Brave/Firecrawl cover the need).

## Providers (v1)

| Provider | Upstream | Key | `FeedItem.source` | Inline embed |
|---|---|---|---|---|
| YouTube | YouTube Data API v3 (existing `youtube.ts`, reuse `getYouTubeSearchItems`) | `YOUTUBE_API_KEY` (set) | `youtube` | yes (existing) |
| DailyMotion | `GET api.dailymotion.com/videos?search=` | none | `dailymotion` | deferred (link-out in v1) |
| Brave | `GET api.search.brave.com/res/v1/videos/search?q=` (`X-Subscription-Token`) | `BRAVE_SEARCH_API_KEY` (Doppler → secret) | `web` | no (link-out) |
| Firecrawl | `POST https://firecrawl-cf.lazee.workers.dev/v1/search` (user's instance) | `FIRECRAWL_API_KEY` if required | `web` | no (link-out) |

DailyMotion fields: `id,title,owner.screenname,thumbnail_360_url,created_time,duration,embed_url`.

## Architecture

```
providers/                       aggregator              surfaces
  youtube.ts   (exists, reuse) ─┐
  dailymotion.ts ──────────────┤
  brave.ts     ────────────────┼─► discover.ts ─► GET /api/discover/search ─┬─► /discover page
  firecrawl.ts ────────────────┘    (fan-out,                               └─► web_search feed source
                                      dedupe, merge)
```

### New provider clients (`src/workers/`)

Each mirrors `youtube.ts`: a network client wrapping one upstream, with a
read-through KV cache (`CACHE` binding) + 7-day "last-good" outage fallback, and
pure normalizer functions (unit-tested in the node env). The `cached()` helper
in `youtube.ts` is extracted to a shared module (`src/workers/cache.ts`) so all
providers reuse it rather than duplicating the read-through + last-good logic.

- **`dailymotion.ts`** — `getDailyMotionSearchItems(env, query, fetcher?)`;
  `normalizeDailyMotionItem(raw): FeedItem | null`. `source:'dailymotion'`.
  No API key. Cache TTL 30 min.
- **`brave.ts`** — `getBraveVideoSearchItems(env, query, fetcher?)`;
  `normalizeBraveVideo(raw): FeedItem | null`. `source:'web'`, link-out.
  Header `X-Subscription-Token: env.BRAVE_SEARCH_API_KEY`. TTL 30 min.
  Throws a typed config error when the key is missing (mirrors
  `YouTubeConfigError`) so the provider degrades to an error badge.
- **`firecrawl.ts`** — `getFirecrawlVideoItems(env, query, fetcher?)`;
  `normalizeFirecrawlResult(raw): FeedItem | null`. `source:'web'`, link-out.
  Calls the user's instance at `FIRECRAWL_URL`. TTL 30 min. Filters results to
  video-bearing pages; non-video results are dropped (`normalize` returns null).

### Schema change (`feed-item.ts`)

- `FeedItemSource` extends to `'spooool' | 'youtube' | 'tiktok' | 'dailymotion' | 'web'`.
- `FeedItem.embed` gains an optional `{ kind: 'dailymotion'; videoId: string }`
  variant (populated but not yet consumed for inline play until Phase 1).
- `FeedSourceKind` extends with `'web_search'`.

### Aggregator (`src/workers/discover.ts`)

- `aggregateSearch(env, { q, providers, order, cursor, limit }, fetcher?)`:
  - Fans out to selected providers via `Promise.allSettled`. Each provider's
    result becomes a `SourceResult` (reusing the existing type) carrying `items`,
    optional `error`, optional `stale`.
  - **Dedupe** across providers by canonical key: YouTube `videoId` when
    `source==='youtube'`, else a normalized URL (lowercased host+path, tracking
    params stripped). First occurrence wins; later duplicates merged away.
  - **Ordering**:
    - `relevance` (default for search): round-robin interleave preserving each
      provider's returned rank — provider A item 1, provider B item 1, … then
      A item 2, etc. Stable and deterministic.
    - `date`: reuse the existing newest-first `compareDesc` from `feed-item.ts`.
  - **Pagination**: cursor-based. For `date`, reuse `assembleFeed`. For
    `relevance`, a parallel `assembleByRank` that encodes `(rank|providerKey|id)`
    in the cursor. Both live in `feed-item.ts` and are unit-tested.
  - Returns `{ items, nextCursor, providers: [{ key, error?, stale? }] }`.

### API router (Hono, mounted at `/api/discover` in `src/workers/index.ts`)

- `GET /api/discover/search`
  - Query params: `q` (required, non-empty), `providers` (CSV, default all),
    `order` (`relevance`|`date`, default `relevance`), `cursor`, `limit`
    (default 15, max 50).
  - Auth: same middleware as feed routes (logged-in users).
  - 400 on empty `q`. Provider-level failures are 200 with per-provider error
    badges (never a hard failure when at least one provider succeeds).

### Saved-search feed source

- **Migration `0024_web_search_source.sql`**: SQLite cannot alter a CHECK
  constraint in place, so recreate `feed_sources` with the CHECK extended to
  include `'web_search'` (create new table, copy rows, drop old, rename), and
  recreate `idx_feed_sources_feed`. `ref` stores JSON `{ "q": string,
  "providers": string[] }` for `web_search` rows (other kinds keep their
  existing `ref` meaning).
- **`feeds.ts`** item-assembly: when a source `kind === 'web_search'`, parse
  `ref` JSON and call `aggregateSearch`, producing a `SourceResult` that merges
  into the feed alongside the other sources (existing merge path via
  `assembleFeed`, `order:'date'` within the feed for chronological consistency).
- **`feed-warm.ts`**: `web_search` sources are NOT pre-warmed in v1 (mirrors the
  existing decision to exclude `youtube_search` from warming — search calls are
  the most quota/cost-sensitive). Documented in the warmer.

### Frontend

- **`src/frontend/pages/Discover.tsx`** (`/discover` route, code-split like other
  routes): search bar, provider filter chips (YouTube / DailyMotion / Web),
  order toggle (Relevance / Newest), results grid reusing **`FeedItemCard`**,
  cursor-based infinite scroll, per-provider status/error badges (reuse the
  `FeedView` badge pattern), and a **"Save as feed source"** action that opens a
  picker of the user's feeds and POSTs a `web_search` source.
- **`src/frontend/lib/discover-client.ts`**: typed fetch client mirroring
  `feeds-client.ts` (`searchDiscover(params): Promise<DiscoverResponse>`).
- **`src/frontend/pages/FeedView.tsx`**: render the `web_search` source kind in
  the source list and support adding one inline (query + provider selection).
- Route registration in the frontend router + a nav entry to `/discover`.

## Config

| Name | Type | Where | Notes |
|---|---|---|---|
| `YOUTUBE_API_KEY` | secret | already set | reused |
| `BRAVE_SEARCH_API_KEY` | secret | Doppler → `wrangler secret put` | Brave video search |
| `FIRECRAWL_URL` | var (`wrangler.toml [vars]`) | `https://firecrawl-cf.lazee.workers.dev` | user's instance |
| `FIRECRAWL_API_KEY` | secret | only if the instance requires auth | optional |

The worker `Env` type (`src/workers/index.ts`) is extended with the new fields.

## Error Handling

- Each provider isolated via `Promise.allSettled`; a throw/timeout becomes a
  per-provider `error` badge, not a page failure.
- Missing provider config → typed config error → provider reported as errored
  while others still return (graceful degradation).
- Read-through cache `last-good` fallback marks degraded providers `stale`.
- Empty `q` → 400 before any upstream call.

## Testing

- **Pure normalizers** (`normalizeDailyMotionItem`, `normalizeBraveVideo`,
  `normalizeFirecrawlResult`) unit-tested in the node env, like
  `youtube.test.ts`, against captured sample payloads.
- **Dedupe + ordering** (`assembleByRank`, dedupe key) unit-tested with
  synthetic `FeedItem[]`.
- **Provider clients** tested with an injected `fetcher` (mock) covering success,
  upstream error, missing-key config error, and cache last-good fallback.
- **Aggregator** tested with mocked providers covering partial failure, dedupe
  across providers, both order modes, and cursor pagination.
- CI runs Node 20 — test scripts MUST NOT use `--configLoader native`.

## Build Sequence

1. Extract `cached()` → `src/workers/cache.ts`; repoint `youtube.ts`.
2. Extend `feed-item.ts` types + add `assembleByRank` + dedupe helper (+ tests).
3. `dailymotion.ts`, `brave.ts`, `firecrawl.ts` provider clients (+ tests).
4. `discover.ts` aggregator (+ tests).
5. `/api/discover` Hono router + `Env` additions + config in `wrangler.toml`.
6. Migration `0024_web_search_source.sql`; `feeds.ts` web_search assembly;
   `feed-warm.ts` exclusion note.
7. Frontend: `discover-client.ts`, `Discover.tsx`, route + nav, `FeedView.tsx`
   web_search support.
8. Set secrets (`BRAVE_SEARCH_API_KEY`), deploy config.
