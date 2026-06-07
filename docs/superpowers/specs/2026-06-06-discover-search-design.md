# Unified Cross-Web Video Search + Inline Play (Discover) — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)
**Phase:** Initial phase of the "Cobalt-powered feed" initiative

## Context

The spooool feed (`src/workers/feeds.ts`, `src/frontend/pages/FeedView.tsx`)
currently aggregates read-only items from a fixed set of source kinds
(spooool channels, YouTube channels/playlists/search, TikTok videos),
normalizing everything to a shared `FeedItem` (`src/workers/feed-item.ts`).
Only YouTube items embed inline; everything else links out.

This phase adds **unified video search across the web** AND **inline playback of
any surfaced video**. The initiative originally split these (search = Phase 2,
Cobalt playback = Phase 1); per decision, this initial phase ships **search +
inline-play together**, and inline-play is the must-complete deliverable.

Remaining deferred work:

- **Cobalt import-to-spooool / download** actions (later phase).
- **Trends surface** — "what's hot", Google Trends / pytrends, Metagraph API
  (later phase).

## Goals

- One search query → aggregated, deduped results across multiple providers,
  normalized to the existing `FeedItem` schema and rendered with `FeedItemCard`.
- **Inline play of ANY surfaced video** — not just YouTube — without leaving spooool.
- Two consuming surfaces: a dedicated `/discover` page, and a saveable
  `web_search` feed-source kind.
- Provider failures isolated and surfaced per-provider, never blanking the page.

## Non-Goals (explicitly deferred)

- Cobalt import-to-spooool / download (later phase). Cobalt is used here **only**
  to resolve a playable stream for inline playback.
- Trends / "what's hot", pytrends, Metagraph API (later phase).
- Invidious provider (dropped: cannot run on Cloudflare Workers).
- Migrating native upload playback off `@cloudflare/stream-react`. Mantine Video
  is introduced for **surfaced/external** videos only this phase; `Watch.tsx` /
  `stream-player.tsx` are untouched (possible future unification).

## Search Providers (v1)

| Provider | Upstream | Key | `FeedItem.source` |
|---|---|---|---|
| YouTube | YouTube Data API v3 (existing `youtube.ts`, reuse `getYouTubeSearchItems`) | `YOUTUBE_API_KEY` (set) | `youtube` |
| DailyMotion | `GET api.dailymotion.com/videos?search=` | none | `dailymotion` |
| Brave | `GET api.search.brave.com/res/v1/videos/search?q=` (`X-Subscription-Token`) | `BRAVE_SEARCH_API_KEY` (Doppler → secret) | `web` |
| Firecrawl | `POST https://firecrawl-cf.lazee.workers.dev/v1/search` (user's instance) | `FIRECRAWL_API_KEY` if required | `web` |

DailyMotion fields: `id,title,owner.screenname,thumbnail_360_url,created_time,duration`.

## Inline Playback (Cobalt + Mantine Video)

Playback is decided **per item at play time**, not stored on the `FeedItem`:

- **`source === 'youtube'`** → existing YouTube **iframe embed** (`embed:{kind:'youtube'}`).
  Reliable, zero Cobalt load.
- **everything else** (`dailymotion`, `web`, `tiktok`) → **Cobalt resolves the
  item's canonical `url` to a muxed MP4**, played in a **Mantine Video** component.
- **`source === 'spooool'`** → native uploads keep `@cloudflare/stream-react`
  (unchanged; handled by the existing card link to `Watch.tsx`).

### Cobalt client (`src/workers/cobalt.ts`)

- User's instance: `COBALT_URL = https://cobalt-api.lazee.workers.dev` (Cobalt 11.7.1).
- `resolvePlayable(env, url, fetcher?)`:
  - `POST {COBALT_URL}/` with `Accept: application/json`,
    `Content-Type: application/json`, optional `Authorization: Api-Key {COBALT_API_KEY}`,
    body `{ url, downloadMode: "auto", videoQuality: "720" }`.
  - Response handling by `status`:
    - `tunnel` / `redirect` → `{ kind: 'mp4', url }`.
    - `picker` → pick the first video entry → `{ kind: 'mp4', url }`.
    - `error` → typed `CobaltError` (message surfaced to the card).
  - Returns `{ kind: 'mp4' | 'hls', url }`.
- **Ephemerality:** Cobalt tunnel/redirect URLs are short-lived, so they are
  **resolved on demand at play time** and cached only briefly (KV, TTL ~5 min)
  keyed by source URL hash. No long-lived caching of stream URLs.

### API: resolve endpoint

- `GET /api/discover/resolve?url=<canonical url>` (auth: logged-in users).
  Returns `{ kind, url }` or `{ error }`. Called by the frontend when the user
  hits play on a non-YouTube card.

### Frontend player

- **Add dependencies:** `@mantine/core`, `@mantine/hooks`, `@gfazioli/mantine-video`.
  Wrap the app (or just the Discover/feed subtree) in `MantineProvider` + import
  Mantine CSS. Mantine coexists with the existing Radix + custom CSS.
- **`src/frontend/components/InlineVideoPlayer.tsx`:** given a `FeedItem`,
  renders the YouTube iframe for YouTube, else calls `resolve`, then plays the
  MP4 in Mantine Video. For HLS results, attach the existing **`hls.js`** to the
  Mantine `<video>` ref via the `useVideo` headless hook.
- Play happens inline in the card / in a lightweight modal over the grid.

## Architecture

```
search providers/                 aggregator            surfaces            playback
  youtube.ts   (reuse) ─┐
  dailymotion.ts ───────┤                                                  ┌─ youtube → iframe
  brave.ts     ─────────┼─► discover.ts ─► /api/discover/search ─► /discover ┤
  firecrawl.ts ─────────┘    (fan-out,                          └─ web_search └─ else → /api/discover/resolve
                              dedupe, merge)                       feed source     (cobalt.ts) → MP4 → Mantine Video
```

### New search provider clients (`src/workers/`)

Each mirrors `youtube.ts`: a network client + read-through KV cache (`CACHE`) +
7-day "last-good" outage fallback + pure normalizers (unit-tested in node env).
The `cached()` helper in `youtube.ts` is extracted to `src/workers/cache.ts` and
reused by all providers.

- **`dailymotion.ts`** — `getDailyMotionSearchItems`, `normalizeDailyMotionItem`.
  `source:'dailymotion'`. No key. TTL 30 min.
- **`brave.ts`** — `getBraveVideoSearchItems`, `normalizeBraveVideo`.
  `source:'web'`. `X-Subscription-Token` header; typed config error when key
  missing (mirrors `YouTubeConfigError`). TTL 30 min.
- **`firecrawl.ts`** — `getFirecrawlVideoItems`, `normalizeFirecrawlResult`.
  `source:'web'`. Filters to video-bearing pages (non-video → null). TTL 30 min.

### Schema change (`feed-item.ts`)

- `FeedItemSource` → `'spooool' | 'youtube' | 'tiktok' | 'dailymotion' | 'web'`.
- `FeedSourceKind` gains `'web_search'`.
- `FeedItem` is otherwise unchanged; playback is resolved at play time, not stored.

### Aggregator (`src/workers/discover.ts`)

- `aggregateSearch(env, { q, providers, order, cursor, limit }, fetcher?)`:
  fans out via `Promise.allSettled` (each → a `SourceResult`); **dedupes** across
  providers by canonical key (YouTube `videoId`, else normalized URL with
  tracking params stripped); orders by `relevance` (round-robin interleave
  preserving each provider's rank — default) or `date` (existing `compareDesc`);
  cursor-paginates. `relevance` adds `assembleByRank` in `feed-item.ts`; `date`
  reuses `assembleFeed`. Returns `{ items, nextCursor, providers:[{key,error?,stale?}] }`.

### API router (Hono, mounted at `/api/discover` in `src/workers/index.ts`)

- `GET /api/discover/search?q=&providers=&order=&cursor=&limit=` — `q` required
  (400 if empty); `providers` CSV (default all); `order` default `relevance`;
  `limit` default 15 / max 50. Per-provider failures → 200 with error badges.
- `GET /api/discover/resolve?url=` — Cobalt playback resolution (above).
- Auth: same middleware as feed routes.

### Saved-search feed source

- **Migration `0024_web_search_source.sql`:** recreate `feed_sources` with the
  `kind` CHECK extended to include `'web_search'` (create new table, copy, drop,
  rename; recreate `idx_feed_sources_feed`). `ref` stores JSON
  `{ "q": string, "providers": string[] }` for `web_search` rows.
- **`feeds.ts`** item assembly: `kind==='web_search'` → parse `ref` → call
  `aggregateSearch` → `SourceResult` merges via `assembleFeed` (`order:'date'`
  within a feed). `feed-warm.ts` does NOT pre-warm `web_search` (mirrors the
  existing `youtube_search` exclusion; documented in the warmer).

### Frontend

- **`Discover.tsx`** (`/discover`, code-split): search bar, provider filter chips,
  order toggle, results grid reusing `FeedItemCard`, cursor infinite-scroll,
  per-provider status badges, inline play via `InlineVideoPlayer`, and a
  **"Save as feed source"** action.
- **`discover-client.ts`:** typed client (`searchDiscover`, `resolvePlayable`).
- **`InlineVideoPlayer.tsx`:** YouTube iframe vs. Cobalt-resolved Mantine Video.
- **`FeedView.tsx`:** render + add the `web_search` source kind; inline play uses
  the same `InlineVideoPlayer`.
- Route registration + nav entry to `/discover`; `MantineProvider` setup.

## Config

| Name | Type | Where | Notes |
|---|---|---|---|
| `YOUTUBE_API_KEY` | secret | already set | reused |
| `BRAVE_SEARCH_API_KEY` | secret | Doppler → `wrangler secret put` | Brave video search |
| `FIRECRAWL_URL` | var (`[vars]`) | `https://firecrawl-cf.lazee.workers.dev` | user's instance |
| `FIRECRAWL_API_KEY` | secret | only if instance requires auth | optional |
| `COBALT_URL` | var (`[vars]`) | `https://cobalt-api.lazee.workers.dev` | user's instance |
| `COBALT_API_KEY` | secret | only if instance requires auth | optional |

Worker `Env` (`src/workers/index.ts`) extended with the new fields.

## Error Handling

- Search providers isolated via `Promise.allSettled` → per-provider error badge.
- Missing provider config → typed config error → that provider errors while
  others still return.
- Cache last-good fallback marks degraded providers `stale`.
- Cobalt resolve failure → card shows a "couldn't play — open original" link-out.
- Empty `q` → 400 before any upstream call.

## Testing

- **Pure normalizers** (`normalizeDailyMotionItem`, `normalizeBraveVideo`,
  `normalizeFirecrawlResult`) + **dedupe/ordering** (`assembleByRank`) unit-tested
  in node env, like `youtube.test.ts`.
- **Provider clients** + **`cobalt.ts`** tested with injected `fetcher`: success,
  upstream error, missing-key config error, cache last-good; Cobalt
  tunnel/redirect/picker/error statuses.
- **Aggregator** tested with mocked providers: partial failure, cross-provider
  dedupe, both order modes, cursor pagination.
- Frontend `InlineVideoPlayer` smoke-tested (YouTube branch vs. resolve branch).
- CI runs Node 20 — test scripts MUST NOT use `--configLoader native`.

## Build Sequence

1. Extract `cached()` → `src/workers/cache.ts`; repoint `youtube.ts`.
2. Extend `feed-item.ts` types + `assembleByRank` + dedupe helper (+ tests).
3. `dailymotion.ts`, `brave.ts`, `firecrawl.ts` search clients (+ tests).
4. `cobalt.ts` resolve client (+ tests).
5. `discover.ts` aggregator (+ tests).
6. `/api/discover` router (`search` + `resolve`) + `Env` additions + `wrangler.toml` vars.
7. Migration `0024_web_search_source.sql`; `feeds.ts` web_search assembly;
   `feed-warm.ts` exclusion note.
8. Frontend: Mantine deps + `MantineProvider`, `InlineVideoPlayer.tsx`,
   `discover-client.ts`, `Discover.tsx`, route + nav, `FeedView.tsx` web_search.
9. Set secrets (`BRAVE_SEARCH_API_KEY`), deploy config.
