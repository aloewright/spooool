# Spooool — Multi-Source Custom Video Feeds (Phase 1) — Design Spec

## Context

Spooool is a Cloudflare-native video host ("a video host that respects your time"): a React 18 + Vite SPA served by a Hono Worker (`src/workers/index.ts`) via the `[assets]` binding with SPA fallback. All hosted video lives in R2 + Cloudflare Stream, with metadata in D1 (`src/db/schema.sql`), and playback is unified on `@cloudflare/stream-react` (`src/frontend/lib/stream-player.tsx`). Worker domains follow a one-file-per-concern pattern under `src/workers/` (e.g. `videos.ts`, `channels.ts`, `tags.ts`), each exporting a Hono sub-router mounted in `index.ts`.

Today every surface — trending, subscriptions, playlists — shows **only spooool's own hosted videos**. There is an internal `playlists` / `playlist_videos` model, but it references internal `videos` only.

We are adding **custom multi-source video feeds**: logged-in users compose named feeds that aggregate items across services — spooool channels, YouTube (channel / playlist / search), and pasted TikTok video URLs — into one reverse-chronological stream.

This spec covers **Phase 1** only. Phase 2 (OAuth account sync) is explicitly designed-for but not built (see "Phase 2 seams").

## Decisions locked during brainstorming

- **Content model:** Both, phased. Phase 1 = curated public sources; Phase 2 = personal OAuth account sync (separate spec).
- **Playback/render:** Mixed — YouTube embeds inline (click-to-load `youtube-nocookie` iframe); TikTok renders an oEmbed metadata card that links out; spooool items play in the existing Stream player.
- **TikTok in Phase 1:** Pasted **video URLs** via public **oEmbed** only. TikTok's official APIs cannot list an arbitrary creator's videos (Display API returns only the connected user's own videos after Login Kit OAuth; Research API is academic-approval gated). So creator aggregation is not possible for TikTok — confirmed against current TikTok developer docs.
- **Source mixing:** A feed can mix all three — spooool + YouTube + TikTok.
- **Fetch/cache strategy:** Approach C (Hybrid) — sources in D1, per-**source** KV caching shared across feeds/users, on-demand merge, light cron warm. Growth path to a materialized `feed_items` table (Approach B) without changing the source model.

## Goals

- Users create/edit/delete named feeds (private by default, optionally public/shareable — mirrors `playlists.is_public`).
- A feed aggregates an ordered set of sources of five kinds: `spooool_channel`, `youtube_channel`, `youtube_playlist`, `youtube_search`, `tiktok_video`.
- `GET /api/feeds/:id/items` returns a merged, reverse-chronological, paginated list of normalized `FeedItem`s.
- YouTube Data API quota is conserved via per-source KV caching (two feeds/users referencing the same channel share one cached fetch).
- A single failing/quota-exhausted source **never** fails the whole feed — graceful per-source degradation with last-good cache.
- Keep `lint:no-providers` green: YouTube Data API (`googleapis.com/youtube/v3`) and TikTok oEmbed are **not** model calls and are not forbidden by `scripts/check-no-direct-providers.mjs` (which targets LLM/embedding/image/audio providers only). No AI-Gateway routing applies.

## Non-goals (YAGNI for Phase 1)

- OAuth / personal account sync (YouTube subscriptions, TikTok own-uploads) — Phase 2.
- TikTok creator aggregation (infeasible via official APIs).
- A materialized `feed_items` table (documented growth path, not built).
- Comments/likes/views on external items; cross-service search; recommendation ranking beyond chronological; re-hosting or re-encoding external video.
- Loading the YouTube IFrame JS API (we use a plain nocookie `<iframe>` — no extra `script-src`).

## Architecture

```
                         BROWSER (React 18 SPA, lazy routes)
   /feeds ── Feeds.tsx (list/create)        /feeds/:id ── FeedView.tsx
        │                                        │  (merged grid + manage-sources panel)
        │ feeds-client.ts (fetch /api/feeds…)    │   FeedItemCard ─┬─ spooool → <Link>/watch/:id (Stream)
        ▼                                        ▼                 ├─ youtube → YouTubeEmbed (click→nocookie iframe)
   ┌──────────────────────────  HONO WORKER (src/workers/index.ts)  ┴─ tiktok → oEmbed card (link-out) ─────┐
   │  feeds.ts  (feedRoutes, mounted in index.ts)                                                           │
   │   POST/GET/PATCH/DELETE /api/feeds[/:id]      (CRUD; owner-only writes, public/owner reads)             │
   │   POST/DELETE /api/feeds/:id/sources[/:sid]   (per-kind validation/normalization)                      │
   │   GET  /api/feeds/:id/items?cursor=…          (assemble → merge → sort → paginate)                     │
   │                                                                                                        │
   │         assemble() in feed-item.ts                                                                     │
   │            ├─ spooool_channel ─► D1 live query (videos by user_id)                                     │
   │            ├─ youtube_*       ─► youtube.ts  ─► KV(per-source) ─miss─► YouTube Data API v3            │
   │            └─ tiktok_video    ─► tiktok.ts   ─► KV(per-url)    ─miss─► tiktok.com/oembed              │
   └──────────┬──────────────────────────────┬───────────────────────────────┬──────────────────────────┘
              │ env.DB (D1)                   │ env.CACHE (KV)                 │ fetch() (server-side)
              ▼                               ▼                                ▼
        feeds / feed_sources            yt:channel:<id> / yt:playlist:<id>   googleapis.com/youtube/v3
        (+ feeds.last_viewed_at)        yt:search:<hash> / tt:video:<hash>   www.tiktok.com/oembed

   CRON (existing "*/5 * * * *" in index.ts scheduled handler):
        warmFeedCaches(env) — refresh per-source KV only for feeds viewed in the last 7 days (bounds quota).
```

Existing bindings reused (exact wrangler names): `DB` (D1), `CACHE` (KV), `STREAM`. New secret: `YOUTUBE_API_KEY`.

## Data model — `src/db/migrations/0022_custom_feeds.sql`

```sql
CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,            -- epoch ms; touched on item-assembly; bounds cron warm set
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE feed_sources (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video')),
  ref TEXT NOT NULL,                 -- spooool user_id | YT channelId | YT playlistId | search query | tiktok URL
  label TEXT NOT NULL DEFAULT '',    -- display label resolved at add-time (channel title, etc.)
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

CREATE INDEX idx_feeds_user ON feeds(user_id);
CREATE INDEX idx_feed_sources_feed ON feed_sources(feed_id);
```

`feeds`/`feed_sources` are a **separate** entity from `playlists`/`playlist_videos` (confirmed in brainstorming): playlists are ordered lists of specific *internal* videos; feeds are dynamic aggregations of *sources* across services. Merging them would overload both. Schema is also added to `src/db/schema.sql` to keep the consolidated reference in sync (per existing repo convention).

## Backend modules (`src/workers/`)

### `feed-item.ts` — normalized type + assembly (pure, unit-testable)
```ts
export type FeedSourceKind =
  | 'spooool_channel' | 'youtube_channel' | 'youtube_playlist'
  | 'youtube_search'  | 'tiktok_video';

export interface FeedItem {
  source: 'spooool' | 'youtube' | 'tiktok';
  id: string;                 // platform-native id (spooool video id / YT video id / tiktok video id)
  title: string;
  author: string;             // channel / creator name
  thumbnailUrl: string | null;
  publishedAt: number;        // epoch ms; sort key
  durationSec: number | null;
  url: string;                // canonical watch URL (used for link-out / spooool /watch route)
  embed?: { kind: 'youtube'; videoId: string }; // present only for inline-embeddable items
}

export interface SourceResult {
  sourceId: string;
  kind: FeedSourceKind;
  items: FeedItem[];
  error?: string;             // present when the source failed; items may be last-good or []
  stale?: boolean;            // served from cache after a refresh failure
}

// merge all SourceResults → sort by publishedAt desc → cursor-paginate
export function assembleFeed(results: SourceResult[], cursor: string | null, limit: number): {
  items: FeedItem[]; nextCursor: string | null; sources: Array<{ sourceId; error?; stale? }>;
}
```

### `youtube.ts` — YouTube Data API v3 client
- Reads `env.YOUTUBE_API_KEY`. Throws a typed `YouTubeQuotaError` on `403 quotaExceeded`/`rateLimitExceeded` so callers degrade gracefully.
- **Input parsing/normalization** (used at source-add time): accepts channel handle (`@name`), channel URL (`/channel/UC…`, `/@handle`, `/c/…`, `/user/…`), playlist URL (`?list=PL…`), or raw ids; resolves handles → channelId; resolves channelId → uploads playlist id (`channels.list?part=contentDetails`).
- **Item fetch:** `playlistItems.list?part=snippet&maxResults=…` (~1 unit) for channel/playlist; `search.list?part=snippet&type=video&order=date` (**100 units**) for search; one batched `videos.list?part=contentDetails` for durations.
- **Normalize** → `FeedItem` with `embed: { kind:'youtube', videoId }`.
- **KV caching** (`env.CACHE`), keyed by source identity, with the TTLs below. On refresh failure, return last-good value flagged `stale`.

### `tiktok.ts` — TikTok oEmbed client
- Validates a TikTok video URL (host in `tiktok.com` / `vm.tiktok.com`), fetches `https://www.tiktok.com/oembed?url=<encoded>` (no credentials).
- Normalizes oEmbed JSON (`title`, `author_name`, `thumbnail_url`) → `FeedItem` (no `embed`; `url` = the canonical TikTok URL). `publishedAt` falls back to the source `added_at` (oEmbed exposes no publish time).
- KV-cached by URL hash, ~24 h.

### `feeds.ts` — `feedRoutes` (Hono), mounted in `index.ts`
```
POST   /api/feeds                      create (auth required)            { name, description?, is_public? }
GET    /api/feeds                      list my feeds (auth required)
GET    /api/feeds/:id                  feed meta + sources               (public feed: anyone; private: owner)
PATCH  /api/feeds/:id                  rename / toggle is_public         (owner)
DELETE /api/feeds/:id                                                    (owner; cascades feed_sources)
POST   /api/feeds/:id/sources          add source { kind, ref }          (owner; validated+labeled per kind)
DELETE /api/feeds/:id/sources/:sid                                       (owner)
GET    /api/feeds/:id/items?cursor=&limit=   assembled items            (public/owner; touches last_viewed_at)
       (limit default 24, max 100; cursor is an opaque base64 of {publishedAt,id} from the last item)
```
- Auth via the existing `c.get('user')` middleware in `index.ts`. Writes are owner-only; reads honor `is_public`.
- Source-add validates `ref` per `kind` (parse/normalize YouTube inputs via `youtube.ts`; validate TikTok host via `tiktok.ts`; verify `spooool_channel` user exists) and stores a resolved `label`.

## Fetch / cache / quota (Approach C — Hybrid)

- **Per-source KV keys** (not per-feed): `yt:channel:<channelId>`, `yt:playlist:<playlistId>`, `yt:search:<sha256(query)>`, `tt:video:<sha256(url)>`. Sharing across feeds/users dedupes quota spend.
- **TTLs:** channel/playlist items ~15 min; search ~30 min (100-unit cost); TikTok oEmbed ~24 h; spooool sources read D1 live (no cache).
- **Assembly:** `feeds.ts` loads sources from D1, resolves each to a `SourceResult` (KV hit, or live fetch + cache write), then `assembleFeed()` merges/sorts/paginates. spooool sources query `videos` by `user_id` directly.
- **Cron warm:** the existing `*/5 * * * *` scheduled branch in `index.ts` calls `warmFeedCaches(env)`, which refreshes per-source KV **only** for feeds whose `last_viewed_at` is within the last 7 days — bounding background quota to feeds people actually use. `GET …/items` touches `last_viewed_at`.

## Frontend (`src/frontend/`)

- **`pages/Feeds.tsx`** (`/feeds`) — list user's feeds; create dialog (name, public toggle).
- **`pages/FeedView.tsx`** (`/feeds/:id`) — merged item grid + a manage-sources panel that accepts a pasted YouTube channel/playlist URL or `@handle`, a search term, a TikTok video URL, or a spooool channel; shows per-source `stale`/`error` chips.
- **`components/FeedItemCard.tsx`** — renders by `source`: `spooool` → `<Link to="/watch/:id">` (Stream player on click-through); `youtube` → `<YouTubeEmbed>`; `tiktok` → oEmbed card that links out (`target="_blank" rel="noopener"`).
- **`components/YouTubeEmbed.tsx`** — thumbnail placeholder that, on click, swaps in `<iframe src="https://www.youtube-nocookie.com/embed/<id>?autoplay=1">`. No YouTube JS, privacy-enhanced, defers third-party load until intent.
- **`lib/feeds-client.ts`** — typed fetch wrappers for the API.
- `App.tsx` — register `/feeds` and `/feeds/:id` as `lazy(() => import(...))` routes (matching existing split) and add a nav link.

## Config / secrets / CSP

- **`YOUTUBE_API_KEY`** — a Cloudflare **secret** (`wrangler secret put YOUTUBE_API_KEY`, Doppler-synced), **not** `[vars]`. Documented with a comment in `wrangler.toml` and an entry in `doppler.yaml`. Typed on the worker `EnvBindings` as optional; `youtube.ts` surfaces a clear error if missing.
- **TikTok** oEmbed needs no credentials.
- **CSP** (`src/workers/security-headers.ts`): add `'frame-src': ['https://www.youtube-nocookie.com']` to `CSP_DIRECTIVES`. `img-src` already allows `https:` (thumbnails OK); `connect-src` unchanged (YouTube/TikTok fetches are server-side). `X-Frame-Options`/`frame-ancestors` only restrict *spooool being framed* and need no change.

## Error handling — graceful degradation

- One failing source never 500s the feed. `youtube.ts` `quotaExceeded`/`403` → serve last-good KV value flagged `stale`; if none, return `items: []` with `error` set. Assembly continues with the remaining sources.
- Invalid/removed TikTok URL or oEmbed 404 → `error` flag, item omitted; surfaced quietly in the manage-sources panel.
- All source inputs validated/normalized at add-time; malformed input is rejected with a 400 before it ever reaches the feed.

## Testing (vitest `*.test.ts`, matching repo conventions)

- `feed-item.test.ts` — merge/sort/cursor-paginate; mixed-source ordering; empty/partial results.
- `youtube.test.ts` — URL/handle/playlist parsing variants; channel→uploads resolution; normalization; KV hit/miss; `quotaExceeded` → stale-cache degradation (mocked `fetch`).
- `tiktok.test.ts` — host validation; oEmbed parse; cache; 404 handling.
- `feeds.test.ts` — CRUD; public vs private read auth; owner-only writes; per-kind source validation; assembly with one source failing; `last_viewed_at` touch.
- `security-headers.test.ts` — assert `frame-src` includes `youtube-nocookie`.
- DOM tests (`*.dom.test.tsx`) — `FeedItemCard` per-source render; `YouTubeEmbed` click-to-load swap.

## Phase 2 seams (designed-for, not built)

- New `feed_sources.kind` values (`youtube_subscriptions`, `tiktok_own`) drop into the same CHECK + assembly switch.
- A future `oauth_connections` table (per-user provider tokens) is read by token-aware variants of `youtube.ts`/`tiktok.ts`; the `FeedItem` normalization and `assembleFeed()` pipeline are unchanged.
- If feeds need deep pagination/outage-resilience, add a materialized `feed_items` table (Approach B); the source model and API stay the same.

## Sources

- TikTok Display API — `video/list` returns only the connected user's own videos; Login Kit OAuth required: <https://developers.tiktok.com/doc/display-api-overview>
- TikTok Research API (handle queries, academic approval): <https://developers.tiktok.com/doc/research-api-get-started>
- YouTube Data API v3 quota costs (search.list = 100 units): standard Google quota documentation.
