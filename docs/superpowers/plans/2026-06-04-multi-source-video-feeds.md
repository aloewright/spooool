# Multi-Source Custom Video Feeds (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in users build named feeds that aggregate spooool channels, YouTube (channel/playlist/search), and pasted TikTok video URLs into one reverse-chronological stream.

**Architecture:** A new `feeds`/`feed_sources` D1 model. Pure helpers (`feed-item.ts`) normalize every source into a `FeedItem` and merge/sort/paginate. `youtube.ts` and `tiktok.ts` are server-side API clients with per-**source** KV caching (shared across feeds → conserves YouTube quota) and stale-on-error fallback. `feeds.ts` exposes Hono routes mounted in `index.ts`. The frontend adds `/feeds` (list/create) and `/feeds/:id` (merged grid + source management); YouTube plays via a click-to-load `youtube-nocookie` iframe, TikTok via an oEmbed card that links out, spooool via the existing Stream `/watch` route.

**Tech Stack:** TypeScript, Hono, Cloudflare D1 + KV, Zod, React 18 + react-router, Vitest (+ happy-dom for component tests). YouTube Data API v3 (API key) and TikTok oEmbed (no credentials) — neither is a model call, so `lint:no-providers` is unaffected and no AI-Gateway routing applies.

**Spec:** `docs/superpowers/specs/2026-06-04-multi-source-video-feeds-design.md`

**Conventions to follow (verified in repo):**
- Worker module = one file under `src/workers/` exporting a Hono sub-router + an `Env` interface with just the bindings it needs; mounted in `src/workers/index.ts` via `app.route('/', …)`.
- IDs: `crypto.randomUUID()` (see `comments.ts:171`).
- Canonical user table is better-auth `user` (columns `id`, `name`, `username`, `displayName`); `videos.user_id` → `user.id`. The legacy `users` table is not used for joins.
- D1: `c.env.DB.prepare(sql).bind(...).first<T>() | .all<T>() | .run()`; multi-write via `c.env.DB.batch([...])`.
- KV: `c.env.CACHE.get/put(key, val, { expirationTtl }) /delete`.
- Auth in routes: `const user = c.get('user'); if (!user) return c.json({ error: 'Unauthorized' }, 401);`.
- SQLite `CURRENT_TIMESTAMP` is `"YYYY-MM-DD HH:MM:SS"` (no `T`/`Z`) — normalize before `Date.parse` (see `Subscriptions.tsx:timeSince`).
- Migrations are numbered with **no gaps**; `migrations.test.ts` asserts `Number(prefix) === index+1`. Latest is `0022` (`0022_studio_assets.sql`), so the new file MUST be `0023`.
- Frontend DOM tests: `// @vitest-environment happy-dom`, raw `ReactDOM.createRoot` + `act`, `globalThis.fetch = vi.fn()` (see `Subscriptions.dom.test.tsx`).

**Run a single test file:** `npx vitest run src/workers/feed-item.test.ts`
**Run the whole suite:** `npm test`
**Type-check:** `npm run type-check`

---

## Task 1: Database migration + schema mirror

**Files:**
- Create: `src/db/migrations/0023_custom_feeds.sql`
- Modify: `src/db/schema.sql` (append the two tables + indexes to keep the consolidated reference in sync)
- Test: `src/db/migrations.test.ts` (add one `it` block)

- [x] **Step 1: Write the failing test**

Add this block inside the `describe('D1 migrations', …)` in `src/db/migrations.test.ts`, after the last existing `it(...)`:

```ts
  it('0023_custom_feeds adds feeds + feed_sources tables and indexes', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0023_custom_feeds.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS feeds/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS feed_sources/);
    expect(sql).toMatch(/kind TEXT NOT NULL/);
    expect(sql).toMatch(/idx_feeds_user/);
    expect(sql).toMatch(/idx_feed_sources_feed/);
  });

  it('schema.sql mirrors the feeds tables from 0023', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS feeds');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS feed_sources');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrations.test.ts`
Expected: FAIL — first the numeric-order test passes for existing files, the new tests fail with `ENOENT … 0023_custom_feeds.sql`.

- [x] **Step 3: Create the migration**

Create `src/db/migrations/0023_custom_feeds.sql`:

```sql
-- Multi-source custom video feeds (Phase 1).
-- feeds: a user-owned, optionally-public named feed.
-- feed_sources: the sources a feed aggregates. `ref` meaning depends on `kind`:
--   spooool_channel  -> user.id
--   youtube_channel  -> resolved YouTube channelId (UC...)
--   youtube_playlist -> YouTube playlistId (PL.../UU...)
--   youtube_search   -> raw search query
--   tiktok_video     -> canonical TikTok video URL
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS feed_sources (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_last_viewed ON feeds(last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);
```

Append the same tables + indexes to the end of `src/db/schema.sql`:

```sql

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS feed_sources (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_last_viewed ON feeds(last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrations.test.ts`
Expected: PASS (all blocks, including the numeric-order check now seeing `0023` at index 22).

- [x] **Step 5: Commit**

```bash
git add src/db/migrations/0023_custom_feeds.sql src/db/schema.sql src/db/migrations.test.ts
git commit -m "feat(feeds): add feeds + feed_sources D1 schema (0023)"
```

---

## Task 2: `feed-item.ts` — normalized item type + assembly

**Files:**
- Create: `src/workers/feed-item.ts`
- Test: `src/workers/feed-item.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/feed-item.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assembleFeed,
  parseSqliteTimestamp,
  type FeedItem,
  type SourceResult,
} from './feed-item';

function item(source: FeedItem['source'], id: string, publishedAt: number): FeedItem {
  return {
    source,
    id,
    title: `title-${id}`,
    author: `author-${id}`,
    thumbnailUrl: null,
    publishedAt,
    durationSec: null,
    url: `https://example.com/${id}`,
  };
}

function result(sourceId: string, items: FeedItem[], extra: Partial<SourceResult> = {}): SourceResult {
  return { sourceId, kind: 'youtube_channel', items, ...extra };
}

describe('parseSqliteTimestamp', () => {
  it('parses a SQLite CURRENT_TIMESTAMP string as UTC', () => {
    const ms = parseSqliteTimestamp('2026-01-02 03:04:05');
    expect(ms).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('passes ISO strings through', () => {
    expect(parseSqliteTimestamp('2026-01-02T03:04:05Z')).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('returns 0 for unparseable input', () => {
    expect(parseSqliteTimestamp('not-a-date')).toBe(0);
  });
});

describe('assembleFeed', () => {
  it('merges across sources and sorts by publishedAt desc', () => {
    const out = assembleFeed(
      [result('s1', [item('youtube', 'a', 100), item('youtube', 'c', 300)]),
       result('s2', [item('spooool', 'b', 200)])],
      null,
      10,
    );
    expect(out.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(out.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and is stable across the boundary', () => {
    const items = [item('youtube', 'a', 500), item('youtube', 'b', 400), item('youtube', 'c', 300)];
    const page1 = assembleFeed([result('s1', items)], null, 2);
    expect(page1.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = assembleFeed([result('s1', items)], page1.nextCursor, 2);
    expect(page2.items.map((i) => i.id)).toEqual(['c']);
    expect(page2.nextCursor).toBeNull();
  });

  it('breaks publishedAt ties deterministically by id desc', () => {
    const out = assembleFeed([result('s1', [item('youtube', 'a', 100), item('youtube', 'b', 100)])], null, 10);
    expect(out.items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('surfaces per-source error/stale flags without dropping other items', () => {
    const out = assembleFeed(
      [result('ok', [item('youtube', 'a', 100)]),
       result('bad', [], { error: 'quota' }),
       result('old', [item('spooool', 'b', 50)], { stale: true })],
      null,
      10,
    );
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(out.sources).toEqual([
      { sourceId: 'ok', kind: 'youtube_channel' },
      { sourceId: 'bad', kind: 'youtube_channel', error: 'quota' },
      { sourceId: 'old', kind: 'youtube_channel', stale: true },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feed-item.test.ts`
Expected: FAIL — `Cannot find module './feed-item'`.

- [ ] **Step 3: Write the implementation**

Create `src/workers/feed-item.ts`:

```ts
// Normalized cross-service feed item + pure assembly (merge/sort/paginate).
// Kept dependency-free so it unit-tests in the node environment.

export type FeedSourceKind =
  | 'spooool_channel'
  | 'youtube_channel'
  | 'youtube_playlist'
  | 'youtube_search'
  | 'tiktok_video';

export type FeedItemSource = 'spooool' | 'youtube' | 'tiktok';

export interface FeedItem {
  source: FeedItemSource;
  id: string; // platform-native id (spooool video id / YT video id / tiktok video id)
  title: string;
  author: string;
  thumbnailUrl: string | null;
  publishedAt: number; // epoch ms; sort key
  durationSec: number | null;
  url: string; // canonical watch/link-out URL
  embed?: { kind: 'youtube'; videoId: string }; // present only for inline-embeddable items
}

export interface SourceResult {
  sourceId: string;
  kind: FeedSourceKind;
  items: FeedItem[];
  error?: string; // present when the source failed
  stale?: boolean; // served from last-good cache after a refresh failure
}

export interface AssembledFeed {
  items: FeedItem[];
  nextCursor: string | null;
  sources: Array<{ sourceId: string; kind: FeedSourceKind; error?: string; stale?: boolean }>;
}

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", no T/Z) parses as local time
// in some engines; force UTC. Returns 0 (epoch) for unparseable input so such
// items sort to the bottom rather than throwing.
export function parseSqliteTimestamp(ts: string): number {
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

// Sort newest-first; tie-break by id desc so pagination is stable.
function compareDesc(a: FeedItem, b: FeedItem): number {
  if (b.publishedAt !== a.publishedAt) return b.publishedAt - a.publishedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function encodeCursor(item: FeedItem): string {
  return btoa(`${item.publishedAt}|${item.id}`);
}

function decodeCursor(cursor: string): { publishedAt: number; id: string } | null {
  try {
    const raw = atob(cursor);
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    const publishedAt = Number.parseInt(raw.slice(0, sep), 10);
    if (!Number.isFinite(publishedAt)) return null;
    return { publishedAt, id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

// Returns true if `item` sorts strictly after the cursor position (desc order).
function isAfterCursor(item: FeedItem, cur: { publishedAt: number; id: string }): boolean {
  if (item.publishedAt !== cur.publishedAt) return item.publishedAt < cur.publishedAt;
  return item.id < cur.id;
}

export function assembleFeed(
  results: SourceResult[],
  cursor: string | null,
  limit: number,
): AssembledFeed {
  const all = results.flatMap((r) => r.items).sort(compareDesc);
  const cur = cursor ? decodeCursor(cursor) : null;
  const visible = cur ? all.filter((i) => isAfterCursor(i, cur)) : all;
  const page = visible.slice(0, limit);
  const nextCursor =
    visible.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;

  const sources = results.map((r) => {
    const entry: { sourceId: string; kind: FeedSourceKind; error?: string; stale?: boolean } = {
      sourceId: r.sourceId,
      kind: r.kind,
    };
    if (r.error) entry.error = r.error;
    if (r.stale) entry.stale = true;
    return entry;
  });

  return { items: page, nextCursor, sources };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/feed-item.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/workers/feed-item.ts src/workers/feed-item.test.ts
git commit -m "feat(feeds): add normalized FeedItem type + assembleFeed"
```

---

## Task 3: `youtube.ts` — input parsing + normalization + duration (pure helpers)

**Files:**
- Create: `src/workers/youtube.ts`
- Test: `src/workers/youtube.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/youtube.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseChannelInput,
  parsePlaylistInput,
  parseIso8601Duration,
  normalizePlaylistItem,
  normalizeSearchItem,
} from './youtube';

describe('parseChannelInput', () => {
  it('reads @handle (bare and URL)', () => {
    expect(parseChannelInput('@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
    expect(parseChannelInput('https://www.youtube.com/@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
  });
  it('reads /channel/UC… ids and bare UC ids', () => {
    const id = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
    expect(parseChannelInput(`https://youtube.com/channel/${id}`)).toEqual({ by: 'id', channelId: id });
    expect(parseChannelInput(id)).toEqual({ by: 'id', channelId: id });
  });
  it('reads legacy /user/NAME', () => {
    expect(parseChannelInput('https://www.youtube.com/user/PewDiePie')).toEqual({ by: 'username', username: 'PewDiePie' });
  });
  it('returns null for clearly invalid input', () => {
    expect(parseChannelInput('   ')).toBeNull();
    expect(parseChannelInput('https://example.com/foo')).toBeNull();
  });
});

describe('parsePlaylistInput', () => {
  it('extracts list= param', () => {
    expect(parsePlaylistInput('https://www.youtube.com/playlist?list=PLabc123')).toBe('PLabc123');
    expect(parsePlaylistInput('https://www.youtube.com/watch?v=x&list=UUxyz')).toBe('UUxyz');
  });
  it('accepts a bare playlist id', () => {
    expect(parsePlaylistInput('PLabc123')).toBe('PLabc123');
  });
  it('returns null otherwise', () => {
    expect(parsePlaylistInput('not a playlist')).toBeNull();
  });
});

describe('parseIso8601Duration', () => {
  it('parses H/M/S', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
    expect(parseIso8601Duration('PT45S')).toBe(45);
    expect(parseIso8601Duration('PT10M')).toBe(600);
  });
  it('returns null for junk', () => {
    expect(parseIso8601Duration('banana')).toBeNull();
  });
});

describe('normalizePlaylistItem', () => {
  it('maps a playlistItems.list entry to a FeedItem with a youtube embed', () => {
    const out = normalizePlaylistItem({
      snippet: {
        title: 'Cool Video',
        videoOwnerChannelTitle: 'Cool Channel',
        publishedAt: '2026-01-02T03:04:05Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } },
      },
      contentDetails: { videoId: 'abc123', videoPublishedAt: '2026-01-02T03:04:05Z' },
    });
    expect(out).toMatchObject({
      source: 'youtube',
      id: 'abc123',
      title: 'Cool Video',
      author: 'Cool Channel',
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      url: 'https://www.youtube.com/watch?v=abc123',
      embed: { kind: 'youtube', videoId: 'abc123' },
    });
    expect(out!.publishedAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('returns null when the videoId is missing', () => {
    expect(normalizePlaylistItem({ snippet: {}, contentDetails: {} })).toBeNull();
  });
});

describe('normalizeSearchItem', () => {
  it('maps a search.list entry to a FeedItem', () => {
    const out = normalizeSearchItem({
      id: { videoId: 'srch1' },
      snippet: {
        title: 'Found It',
        channelTitle: 'Finder',
        publishedAt: '2026-02-02T00:00:00Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/s.jpg' } },
      },
    });
    expect(out).toMatchObject({ source: 'youtube', id: 'srch1', embed: { kind: 'youtube', videoId: 'srch1' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/youtube.test.ts`
Expected: FAIL — `Cannot find module './youtube'`.

- [ ] **Step 3: Write the parsing/normalization half of `youtube.ts`**

Create `src/workers/youtube.ts` with the pure helpers (the network client is added in Task 4 to the same file):

```ts
// YouTube Data API v3 client + pure parsing/normalization helpers.
// NOTE: youtube.com Data API is NOT an LLM/model provider — it is not covered
// by the AI-Gateway rule or scripts/check-no-direct-providers.mjs. Calls go
// direct (server-side) with env.YOUTUBE_API_KEY.

import type { FeedItem } from './feed-item';

const UC_ID_RE = /^UC[\w-]{22}$/;
const PLAYLIST_ID_RE = /^(PL|UU|OL|FL|RD|LL)[\w-]+$/;

export type ChannelRef =
  | { by: 'id'; channelId: string }
  | { by: 'handle'; handle: string }
  | { by: 'username'; username: string };

// Accepts: @handle, youtube.com/@handle, /channel/UC…, bare UC… id, /user/NAME.
export function parseChannelInput(input: string): ChannelRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) return { by: 'handle', handle: trimmed.slice(1) };
  if (UC_ID_RE.test(trimmed)) return { by: 'id', channelId: trimmed };

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url) {
    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;
    const segs = url.pathname.split('/').filter(Boolean);
    if (segs[0]?.startsWith('@')) return { by: 'handle', handle: segs[0].slice(1) };
    if (segs[0] === 'channel' && segs[1] && UC_ID_RE.test(segs[1])) return { by: 'id', channelId: segs[1] };
    if (segs[0] === 'user' && segs[1]) return { by: 'username', username: segs[1] };
    // /c/NAME custom URLs aren't API-resolvable by name; treat the name as a handle (best-effort).
    if (segs[0] === 'c' && segs[1]) return { by: 'handle', handle: segs[1] };
    return null;
  }
  // Bare token that looks handle-ish.
  if (/^[A-Za-z0-9_.-]{2,100}$/.test(trimmed)) return { by: 'handle', handle: trimmed };
  return null;
}

export function parsePlaylistInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const list = url.searchParams.get('list');
    if (list && PLAYLIST_ID_RE.test(list)) return list;
  } catch {
    // not a URL — fall through
  }
  return PLAYLIST_ID_RE.test(trimmed) ? trimmed : null;
}

export function parseIso8601Duration(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + min * 60 + s;
}

// --- normalization ----------------------------------------------------------

interface RawThumbnails {
  medium?: { url?: string };
  high?: { url?: string };
  default?: { url?: string };
}
function pickThumb(t: RawThumbnails | undefined): string | null {
  return t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;
}

interface RawPlaylistItem {
  snippet?: {
    title?: string;
    videoOwnerChannelTitle?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: RawThumbnails;
  };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

export function normalizePlaylistItem(raw: RawPlaylistItem): FeedItem | null {
  const videoId = raw.contentDetails?.videoId;
  if (!videoId) return null;
  const published = raw.contentDetails?.videoPublishedAt ?? raw.snippet?.publishedAt ?? '';
  return {
    source: 'youtube',
    id: videoId,
    title: raw.snippet?.title ?? 'Untitled',
    author: raw.snippet?.videoOwnerChannelTitle ?? raw.snippet?.channelTitle ?? 'YouTube',
    thumbnailUrl: pickThumb(raw.snippet?.thumbnails),
    publishedAt: published ? Date.parse(published) || 0 : 0,
    durationSec: null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    embed: { kind: 'youtube', videoId },
  };
}

interface RawSearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: RawThumbnails };
}

export function normalizeSearchItem(raw: RawSearchItem): FeedItem | null {
  const videoId = raw.id?.videoId;
  if (!videoId) return null;
  return {
    source: 'youtube',
    id: videoId,
    title: raw.snippet?.title ?? 'Untitled',
    author: raw.snippet?.channelTitle ?? 'YouTube',
    thumbnailUrl: pickThumb(raw.snippet?.thumbnails),
    publishedAt: raw.snippet?.publishedAt ? Date.parse(raw.snippet.publishedAt) || 0 : 0,
    durationSec: null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    embed: { kind: 'youtube', videoId },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/youtube.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/youtube.ts src/workers/youtube.test.ts
git commit -m "feat(feeds): add YouTube input parsing + item normalization"
```

---

## Task 4: `youtube.ts` — network client, KV caching, quota degradation

**Files:**
- Modify: `src/workers/youtube.ts` (append the client)
- Test: `src/workers/youtube.test.ts` (append client tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/workers/youtube.test.ts` (add imports to the existing import block and the new `describe`s at the bottom):

```ts
import {
  getYouTubeChannelItems,
  getYouTubeSearchItems,
  resolveYouTubeChannel,
  YouTubeQuotaError,
  type YouTubeEnv,
} from './youtube';

// minimal in-memory KV
function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function quotaResponse(): Response {
  return jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
}

describe('getYouTubeChannelItems', () => {
  it('resolves uploads playlist then lists items, and caches the result', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.includes('/channels')) {
        return jsonResponse({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_uploads' } } }] });
      }
      if (u.includes('/playlistItems')) {
        return jsonResponse({
          items: [{ snippet: { title: 'V', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { videoId: 'vid1' } }],
        });
      }
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const first = await getYouTubeChannelItems(env, 'UCX6OQ3DkcsbYNE6H8uQQuVA', fetcher);
    expect(first.items.map((i) => i.id)).toEqual(['vid1']);
    expect(first.error).toBeUndefined();

    const callsAfterFirst = calls.length;
    const second = await getYouTubeChannelItems(env, 'UCX6OQ3DkcsbYNE6H8uQQuVA', fetcher);
    expect(second.items.map((i) => i.id)).toEqual(['vid1']);
    expect(calls.length).toBe(callsAfterFirst); // served from cache, no new network calls
  });

  it('degrades to stale last-good cache when the API hits quota', async () => {
    let mode: 'ok' | 'quota' = 'ok';
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (mode === 'quota') return quotaResponse();
      if (u.includes('/channels')) return jsonResponse({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
      return jsonResponse({ items: [{ snippet: { title: 'V', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { videoId: 'good' } }] });
    }) as typeof fetch;

    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    await getYouTubeChannelItems(env, 'UC1', fetcher); // warms fresh + last-good
    // expire the fresh key so the next read re-fetches
    await env.CACHE.delete('yt:channel:UC1');
    mode = 'quota';
    const degraded = await getYouTubeChannelItems(env, 'UC1', fetcher);
    expect(degraded.stale).toBe(true);
    expect(degraded.items.map((i) => i.id)).toEqual(['good']);
  });

  it('returns an error result (not throw) on quota with no cache', async () => {
    const fetcher = (async () => quotaResponse()) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await getYouTubeChannelItems(env, 'UCnone', fetcher);
    expect(out.items).toEqual([]);
    expect(out.error).toBeTruthy();
  });
});

describe('getYouTubeSearchItems', () => {
  it('maps search results', async () => {
    const fetcher = (async () =>
      jsonResponse({ items: [{ id: { videoId: 's1' }, snippet: { title: 'T', publishedAt: '2026-01-01T00:00:00Z' } }] })) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await getYouTubeSearchItems(env, 'cats', fetcher);
    expect(out.items.map((i) => i.id)).toEqual(['s1']);
  });
});

describe('resolveYouTubeChannel', () => {
  it('resolves a handle to channelId + title', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('forHandle=MrBeast');
      return jsonResponse({ items: [{ id: 'UCresolved', snippet: { title: 'MrBeast' } }] });
    }) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await resolveYouTubeChannel(env, { by: 'handle', handle: 'MrBeast' }, fetcher);
    expect(out).toEqual({ channelId: 'UCresolved', title: 'MrBeast' });
  });
  it('throws when no channel matches', async () => {
    const fetcher = (async () => jsonResponse({ items: [] })) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    await expect(resolveYouTubeChannel(env, { by: 'handle', handle: 'nobody' }, fetcher)).rejects.toThrow();
  });
});

it('YouTubeQuotaError is an Error subclass', () => {
  expect(new YouTubeQuotaError('x')).toBeInstanceOf(Error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/youtube.test.ts`
Expected: FAIL — the new exports (`getYouTubeChannelItems`, etc.) don't exist yet.

- [ ] **Step 3: Append the network client to `src/workers/youtube.ts`**

Add at the end of `src/workers/youtube.ts`:

```ts
// --- network client ---------------------------------------------------------

export interface YouTubeEnv {
  YOUTUBE_API_KEY?: string;
  CACHE: KVNamespace;
}

export interface YouTubeFetchResult {
  items: FeedItem[];
  stale?: boolean;
  error?: string;
}

export class YouTubeQuotaError extends Error {}
export class YouTubeConfigError extends Error {}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_RESULTS = 15;

// Cache TTLs (seconds).
const TTL_ITEMS = 15 * 60; // channel/playlist item lists
const TTL_SEARCH = 30 * 60; // search is 100 quota units — cache longer
const TTL_UPLOADS = 7 * 24 * 60 * 60; // channelId -> uploads playlist mapping is ~static
const TTL_LASTGOOD = 7 * 24 * 60 * 60; // outage fallback

function keyChannel(channelId: string): string {
  return `yt:channel:${channelId}`;
}
function keySearch(query: string): string {
  return `yt:search:${query.trim().toLowerCase()}`.slice(0, 480);
}
function keyUploads(channelId: string): string {
  return `yt:uploads:${channelId}`;
}

async function ytFetch(
  env: YouTubeEnv,
  path: string,
  params: Record<string, string>,
  fetcher: typeof fetch,
): Promise<unknown> {
  if (!env.YOUTUBE_API_KEY) throw new YouTubeConfigError('YOUTUBE_API_KEY is not configured');
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', env.YOUTUBE_API_KEY);
  const res = await fetcher(url.toString());
  if (!res.ok) {
    let reason = `youtube ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
      const r = body.error?.errors?.[0]?.reason;
      if (r) reason = r;
      if (r === 'quotaExceeded' || r === 'rateLimitExceeded' || r === 'dailyLimitExceeded') {
        throw new YouTubeQuotaError(reason);
      }
    } catch (err) {
      if (err instanceof YouTubeQuotaError) throw err;
    }
    throw new Error(reason);
  }
  return res.json();
}

// Read-through cache with a long-lived "last good" copy for outage/quota fallback.
async function cached(
  env: YouTubeEnv,
  key: string,
  ttl: number,
  produce: () => Promise<FeedItem[]>,
): Promise<YouTubeFetchResult> {
  const fresh = await env.CACHE.get(key);
  if (fresh !== null) return { items: JSON.parse(fresh) as FeedItem[] };
  try {
    const items = await produce();
    const json = JSON.stringify(items);
    await env.CACHE.put(key, json, { expirationTtl: ttl });
    await env.CACHE.put(`${key}:lg`, json, { expirationTtl: TTL_LASTGOOD });
    return { items };
  } catch (err) {
    const lastGood = await env.CACHE.get(`${key}:lg`);
    if (lastGood !== null) return { items: JSON.parse(lastGood) as FeedItem[], stale: true };
    return { items: [], error: err instanceof Error ? err.message : 'youtube fetch failed' };
  }
}

async function uploadsPlaylistFor(env: YouTubeEnv, channelId: string, fetcher: typeof fetch): Promise<string> {
  const cachedId = await env.CACHE.get(keyUploads(channelId));
  if (cachedId !== null) return cachedId;
  const data = (await ytFetch(env, 'channels', { part: 'contentDetails', id: channelId }, fetcher)) as {
    items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
  };
  const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('channel has no uploads playlist');
  await env.CACHE.put(keyUploads(channelId), uploads, { expirationTtl: TTL_UPLOADS });
  return uploads;
}

async function listPlaylistItems(env: YouTubeEnv, playlistId: string, fetcher: typeof fetch): Promise<FeedItem[]> {
  const data = (await ytFetch(
    env,
    'playlistItems',
    { part: 'snippet,contentDetails', playlistId, maxResults: String(MAX_RESULTS) },
    fetcher,
  )) as { items?: unknown[] };
  return (data.items ?? [])
    .map((raw) => normalizePlaylistItem(raw as Parameters<typeof normalizePlaylistItem>[0]))
    .filter((i): i is FeedItem => i !== null);
}

// `force` skips the fresh-cache read (used by the cron warmer to refresh).
export async function getYouTubeChannelItems(
  env: YouTubeEnv,
  channelId: string,
  fetcher: typeof fetch = fetch,
  force = false,
): Promise<YouTubeFetchResult> {
  const key = keyChannel(channelId);
  if (force) await env.CACHE.delete(key);
  return cached(env, key, TTL_ITEMS, async () => {
    const uploads = await uploadsPlaylistFor(env, channelId, fetcher);
    return listPlaylistItems(env, uploads, fetcher);
  });
}

export async function getYouTubePlaylistItems(
  env: YouTubeEnv,
  playlistId: string,
  fetcher: typeof fetch = fetch,
  force = false,
): Promise<YouTubeFetchResult> {
  const key = `yt:playlist:${playlistId}`;
  if (force) await env.CACHE.delete(key);
  return cached(env, key, TTL_ITEMS, () => listPlaylistItems(env, playlistId, fetcher));
}

export async function getYouTubeSearchItems(
  env: YouTubeEnv,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<YouTubeFetchResult> {
  return cached(env, keySearch(query), TTL_SEARCH, async () => {
    const data = (await ytFetch(
      env,
      'search',
      { part: 'snippet', type: 'video', order: 'date', q: query, maxResults: String(MAX_RESULTS) },
      fetcher,
    )) as { items?: unknown[] };
    return (data.items ?? [])
      .map((raw) => normalizeSearchItem(raw as Parameters<typeof normalizeSearchItem>[0]))
      .filter((i): i is FeedItem => i !== null);
  });
}

// Used at source-add time to turn a handle/username/id into a stored channelId + label.
export async function resolveYouTubeChannel(
  env: YouTubeEnv,
  ref: ChannelRef,
  fetcher: typeof fetch = fetch,
): Promise<{ channelId: string; title: string }> {
  const params: Record<string, string> = { part: 'snippet' };
  if (ref.by === 'id') params.id = ref.channelId;
  else if (ref.by === 'handle') params.forHandle = ref.handle;
  else params.forUsername = ref.username;
  const data = (await ytFetch(env, 'channels', params, fetcher)) as {
    items?: Array<{ id?: string; snippet?: { title?: string } }>;
  };
  const item = data.items?.[0];
  if (!item?.id) throw new Error('YouTube channel not found');
  return { channelId: item.id, title: item.snippet?.title ?? item.id };
}

// Used at source-add time to label a playlist.
export async function resolveYouTubePlaylistTitle(
  env: YouTubeEnv,
  playlistId: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const data = (await ytFetch(env, 'playlists', { part: 'snippet', id: playlistId }, fetcher)) as {
      items?: Array<{ snippet?: { title?: string } }>;
    };
    return data.items?.[0]?.snippet?.title ?? playlistId;
  } catch {
    return playlistId;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/youtube.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/workers/youtube.ts src/workers/youtube.test.ts
git commit -m "feat(feeds): add YouTube API client with per-source KV cache + quota degradation"
```

---

## Task 5: `tiktok.ts` — oEmbed client

**Files:**
- Create: `src/workers/tiktok.ts`
- Test: `src/workers/tiktok.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/tiktok.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isTikTokVideoUrl, getTikTokItem, type TikTokEnv } from './tiktok';

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isTikTokVideoUrl', () => {
  it('accepts canonical and short TikTok URLs', () => {
    expect(isTikTokVideoUrl('https://www.tiktok.com/@user/video/7300000000000000000')).toBe(true);
    expect(isTikTokVideoUrl('https://vm.tiktok.com/ZMabc123/')).toBe(true);
  });
  it('rejects non-TikTok or junk URLs', () => {
    expect(isTikTokVideoUrl('https://youtube.com/watch?v=x')).toBe(false);
    expect(isTikTokVideoUrl('not a url')).toBe(false);
  });
});

describe('getTikTokItem', () => {
  it('fetches + normalizes oEmbed and caches it', async () => {
    let calls = 0;
    const url = 'https://www.tiktok.com/@user/video/7300000000000000000';
    const fetcher = (async () => {
      calls++;
      return jsonResponse({
        title: 'Funny clip',
        author_name: 'user',
        thumbnail_url: 'https://p16.tiktokcdn.com/x.jpg',
      });
    }) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const first = await getTikTokItem(env, url, 1700000000000, fetcher);
    expect(first.item).toMatchObject({
      source: 'tiktok',
      id: '7300000000000000000',
      title: 'Funny clip',
      author: 'user',
      url,
    });
    expect(first.item?.embed).toBeUndefined();
    await getTikTokItem(env, url, 1700000000000, fetcher);
    expect(calls).toBe(1); // second call served from cache
  });

  it('returns an error for an invalid URL without calling the network', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const out = await getTikTokItem(env, 'https://example.com/x', 0, fetcher);
    expect(out.item).toBeNull();
    expect(out.error).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('returns an error result when oEmbed 404s', async () => {
    const fetcher = (async () => jsonResponse({}, 404)) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const out = await getTikTokItem(env, 'https://www.tiktok.com/@u/video/7300000000000000001', 0, fetcher);
    expect(out.item).toBeNull();
    expect(out.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/tiktok.test.ts`
Expected: FAIL — `Cannot find module './tiktok'`.

- [ ] **Step 3: Write the implementation**

Create `src/workers/tiktok.ts`:

```ts
// TikTok oEmbed client. oEmbed is a public, credential-free endpoint; it is the
// only no-OAuth way to render a TikTok video. Not a model provider — outside
// the AI-Gateway rule.

import type { FeedItem } from './feed-item';

export interface TikTokEnv {
  CACHE: KVNamespace;
}

export interface TikTokFetchResult {
  item: FeedItem | null;
  error?: string;
}

const OEMBED = 'https://www.tiktok.com/oembed';
const TTL = 24 * 60 * 60; // oEmbed payload is static once a video is posted

export function isTikTokVideoUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^www\./, '');
  return host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'm.tiktok.com';
}

// Extract the numeric video id from a canonical URL; fall back to a slug of the
// path so short (vm.tiktok.com) links still get a stable id.
function tiktokId(url: string): string {
  const m = /\/video\/(\d+)/.exec(url);
  if (m) return m[1];
  try {
    return new URL(url).pathname.replace(/\//g, '').slice(0, 40) || url;
  } catch {
    return url;
  }
}

function key(url: string): string {
  return `tt:video:${url.trim()}`.slice(0, 480);
}

export async function getTikTokItem(
  env: TikTokEnv,
  url: string,
  addedAtMs: number,
  fetcher: typeof fetch = fetch,
): Promise<TikTokFetchResult> {
  if (!isTikTokVideoUrl(url)) return { item: null, error: 'Not a TikTok video URL' };

  const cached = await env.CACHE.get(key(url));
  if (cached !== null) return { item: JSON.parse(cached) as FeedItem };

  try {
    const res = await fetcher(`${OEMBED}?url=${encodeURIComponent(url)}`);
    if (!res.ok) return { item: null, error: `tiktok oembed ${res.status}` };
    const body = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    const item: FeedItem = {
      source: 'tiktok',
      id: tiktokId(url),
      title: body.title || 'TikTok video',
      author: body.author_name || 'TikTok',
      thumbnailUrl: body.thumbnail_url ?? null,
      // oEmbed exposes no publish time; use the time the source was added so the
      // item still sorts sensibly within the feed.
      publishedAt: addedAtMs,
      durationSec: null,
      url,
    };
    await env.CACHE.put(key(url), JSON.stringify(item), { expirationTtl: TTL });
    return { item };
  } catch (err) {
    return { item: null, error: err instanceof Error ? err.message : 'tiktok fetch failed' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/tiktok.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/tiktok.ts src/workers/tiktok.test.ts
git commit -m "feat(feeds): add TikTok oEmbed client with KV cache"
```

---

## Task 6: `feeds.ts` — feed CRUD routes

**Files:**
- Create: `src/workers/feeds.ts`
- Test: `src/workers/feeds.test.ts`

This task defines the route module + a compact fake D1 used by all `feeds.test.ts` blocks (Tasks 6–8 add to this same file).

- [ ] **Step 1: Write the failing test**

Create `src/workers/feeds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { feedRoutes, type FeedsEnv } from './feeds';

// ---- compact in-memory D1 + KV doubles (shared by all feeds tests) ----------

interface FeedRow {
  id: string; user_id: string; name: string; description: string;
  is_public: number; last_viewed_at: number | null; created_at: string; updated_at: string;
}
interface SourceRow {
  id: string; feed_id: string; kind: string; ref: string; label: string; position: number; added_at: string;
}
interface Store {
  feeds: FeedRow[];
  feed_sources: SourceRow[];
  users: Array<{ id: string; username: string; label: string }>;
  videos: Array<{ id: string; user_id: string; title: string; thumbnail_url: string | null; created_at: string; author: string }>;
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function fakeDB(store: Store): D1Database {
  function prep(sql: string, binds: unknown[] = []) {
    const q = norm(sql);
    return {
      bind: (...vals: unknown[]) => prep(sql, vals),
      first: async <T>() => {
        if (q.startsWith('SELECT id, user_id, name, description, is_public, last_viewed_at') && q.includes('FROM feeds WHERE id = ?')) {
          return (store.feeds.find((f) => f.id === binds[0]) ?? null) as T | null;
        }
        if (q.includes('FROM user WHERE username = ?')) {
          const u = store.users.find((x) => x.username === binds[0]);
          return (u ? { id: u.id, label: u.label } : null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
        if (q.includes('FROM feeds WHERE user_id = ?')) {
          return { results: store.feeds.filter((f) => f.user_id === binds[0]) as T[] };
        }
        if (q.includes('FROM feed_sources WHERE feed_id = ?')) {
          return { results: store.feed_sources.filter((s) => s.feed_id === binds[0]) as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        if (q.startsWith('INSERT INTO feeds')) {
          const [id, user_id, name, description, is_public] = binds as [string, string, string, string, number];
          store.feeds.push({ id, user_id, name, description, is_public, last_viewed_at: null, created_at: 't', updated_at: 't' });
        } else if (q.startsWith('UPDATE feeds SET name')) {
          const [name, description, is_public, , id] = binds as [string, string, number, unknown, string];
          const f = store.feeds.find((x) => x.id === id);
          if (f) { f.name = name; f.description = description; f.is_public = is_public; }
        } else if (q.startsWith('UPDATE feeds SET last_viewed_at')) {
          const f = store.feeds.find((x) => x.id === binds[1]);
          if (f) f.last_viewed_at = binds[0] as number;
        } else if (q.startsWith('DELETE FROM feed_sources WHERE feed_id = ?')) {
          store.feed_sources = store.feed_sources.filter((s) => s.feed_id !== binds[0]);
        } else if (q.startsWith('DELETE FROM feeds WHERE id = ?')) {
          store.feeds = store.feeds.filter((f) => f.id !== binds[0]);
        } else if (q.startsWith('INSERT INTO feed_sources')) {
          const [id, feed_id, kind, ref, label] = binds as [string, string, string, string, string];
          store.feed_sources.push({ id, feed_id, kind, ref, label, position: 0, added_at: 't' });
        } else if (q.startsWith('DELETE FROM feed_sources WHERE id = ?')) {
          store.feed_sources = store.feed_sources.filter((s) => s.id !== binds[0]);
        }
        return { success: true };
      },
    };
  }
  return {
    prepare: (sql: string) => prep(sql),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    },
  } as unknown as D1Database;
}

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

function emptyStore(): Store {
  return { feeds: [], feed_sources: [], users: [], videos: [] };
}

function makeApp(store: Store, user: { id: string } | null) {
  const env: FeedsEnv = { DB: fakeDB(store), CACHE: fakeKV() };
  // Mimic index.ts middleware that sets c.get('user').
  const { Hono } = require('hono');
  const app = new Hono();
  app.use('*', async (c: any, next: any) => { c.set('user', user); await next(); });
  app.route('/', feedRoutes);
  return { app, env };
}

async function call(store: Store, user: { id: string } | null, method: string, path: string, body?: unknown) {
  const { app, env } = makeApp(store, user);
  const req = new Request(`http://x${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.fetch(req, env);
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

// ---- CRUD tests --------------------------------------------------------------

describe('feeds CRUD', () => {
  it('requires auth to create', async () => {
    const store = emptyStore();
    const res = await call(store, null, 'POST', '/api/feeds', { name: 'My Feed' });
    expect(res.status).toBe(401);
  });

  it('creates, lists, gets, patches, and deletes a feed', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };

    const created = await call(store, user, 'POST', '/api/feeds', { name: 'My Feed' });
    expect(created.status).toBe(200);
    const id = created.json.feed.id as string;
    expect(created.json.feed).toMatchObject({ name: 'My Feed', is_public: 0 });

    const list = await call(store, user, 'GET', '/api/feeds');
    expect(list.json.feeds).toHaveLength(1);

    const got = await call(store, user, 'GET', `/api/feeds/${id}`);
    expect(got.json.feed.id).toBe(id);
    expect(got.json.sources).toEqual([]);

    const patched = await call(store, user, 'PATCH', `/api/feeds/${id}`, { name: 'Renamed', is_public: true });
    expect(patched.json.feed).toMatchObject({ name: 'Renamed', is_public: 1 });

    const del = await call(store, user, 'DELETE', `/api/feeds/${id}`);
    expect(del.status).toBe(200);
    const listAfter = await call(store, user, 'GET', '/api/feeds');
    expect(listAfter.json.feeds).toHaveLength(0);
  });

  it('rejects body without a name', async () => {
    const store = emptyStore();
    const res = await call(store, { id: 'u1' }, 'POST', '/api/feeds', { description: 'x' });
    expect(res.status).toBe(400);
  });

  it('hides a private feed from non-owners but shows a public one', async () => {
    const store = emptyStore();
    const owner = { id: 'owner' };
    const created = await call(store, owner, 'POST', '/api/feeds', { name: 'Secret' });
    const id = created.json.feed.id as string;

    const stranger = { id: 'other' };
    expect((await call(store, stranger, 'GET', `/api/feeds/${id}`)).status).toBe(404);

    await call(store, owner, 'PATCH', `/api/feeds/${id}`, { is_public: true });
    expect((await call(store, stranger, 'GET', `/api/feeds/${id}`)).status).toBe(200);
    expect((await call(store, null, 'GET', `/api/feeds/${id}`)).status).toBe(200);
  });

  it('forbids editing someone else’s feed', async () => {
    const store = emptyStore();
    const created = await call(store, { id: 'owner' }, 'POST', '/api/feeds', { name: 'Mine' });
    const id = created.json.feed.id as string;
    expect((await call(store, { id: 'other' }, 'PATCH', `/api/feeds/${id}`, { name: 'hax' })).status).toBe(403);
    expect((await call(store, { id: 'other' }, 'DELETE', `/api/feeds/${id}`)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: FAIL — `Cannot find module './feeds'`.

- [ ] **Step 3: Write the CRUD routes**

Create `src/workers/feeds.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import {
  assembleFeed,
  parseSqliteTimestamp,
  type FeedItem,
  type FeedSourceKind,
  type SourceResult,
} from './feed-item';
import {
  getYouTubeChannelItems,
  getYouTubePlaylistItems,
  getYouTubeSearchItems,
  parseChannelInput,
  parsePlaylistInput,
  resolveYouTubeChannel,
  resolveYouTubePlaylistTitle,
  type YouTubeEnv,
} from './youtube';
import { getTikTokItem, isTikTokVideoUrl, type TikTokEnv } from './tiktok';

export interface FeedsEnv extends YouTubeEnv, TikTokEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

type SessionUser = { id: string } | null;
type FeedsVariables = { user: SessionUser };

interface FeedRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  is_public: number;
  last_viewed_at: number | null;
  created_at: string;
  updated_at: string;
}
interface SourceRow {
  id: string;
  feed_id: string;
  kind: FeedSourceKind;
  ref: string;
  label: string;
  position: number;
  added_at: string;
}

const FEED_SELECT =
  'SELECT id, user_id, name, description, is_public, last_viewed_at, created_at, updated_at FROM feeds';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  is_public: z.boolean().optional(),
});
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  is_public: z.boolean().optional(),
});

function publicFeed(f: FeedRow) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    is_public: f.is_public,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

async function loadFeed(env: FeedsEnv, id: string): Promise<FeedRow | null> {
  return env.DB.prepare(`${FEED_SELECT} WHERE id = ?`).bind(id).first<FeedRow>();
}

export const feedRoutes = new Hono<{ Bindings: FeedsEnv; Variables: FeedsVariables }>();

feedRoutes.post('/api/feeds', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO feeds (id, user_id, name, description, is_public) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, parsed.data.name, parsed.data.description ?? '', parsed.data.is_public ? 1 : 0)
    .run();
  const feed = await loadFeed(c.env, id);
  return c.json({ feed: feed ? publicFeed(feed) : null });
});

feedRoutes.get('/api/feeds', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `${FEED_SELECT} WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<FeedRow>();
  return c.json({ feeds: (results ?? []).map(publicFeed) });
});

feedRoutes.get('/api/feeds/:id', async (c) => {
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  const user = c.get('user');
  const isOwner = user?.id === feed.user_id;
  if (!feed.is_public && !isOwner) return c.json({ error: 'Feed not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources WHERE feed_id = ? ORDER BY position ASC, added_at ASC`,
  )
    .bind(feed.id)
    .all<SourceRow>();
  const sources = (results ?? []).map((s) => ({ id: s.id, kind: s.kind, ref: s.ref, label: s.label }));
  return c.json({ feed: { ...publicFeed(feed), is_owner: isOwner }, sources });
});

feedRoutes.patch('/api/feeds/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const name = parsed.data.name ?? feed.name;
  const description = parsed.data.description ?? feed.description;
  const isPublic = parsed.data.is_public === undefined ? feed.is_public : parsed.data.is_public ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE feeds SET name = ?, description = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(name, description, isPublic, feed.id)
    .run();
  const updated = await loadFeed(c.env, feed.id);
  return c.json({ feed: updated ? publicFeed(updated) : null });
});

feedRoutes.delete('/api/feeds/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM feed_sources WHERE feed_id = ?`).bind(feed.id),
    c.env.DB.prepare(`DELETE FROM feeds WHERE id = ?`).bind(feed.id),
  ]);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: PASS (CRUD blocks).

- [ ] **Step 5: Commit**

```bash
git add src/workers/feeds.ts src/workers/feeds.test.ts
git commit -m "feat(feeds): add feed CRUD routes with owner/public auth"
```

---

## Task 7: `feeds.ts` — source add/delete with per-kind validation

**Files:**
- Modify: `src/workers/feeds.ts` (add source routes + a `resolveSource` helper)
- Test: `src/workers/feeds.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing tests**

Append to `src/workers/feeds.test.ts`:

```ts
describe('feed sources', () => {
  it('adds a spooool_channel source resolved from a username', async () => {
    const store = emptyStore();
    store.users.push({ id: 'creator1', username: 'cool', label: 'Cool Creator' });
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;

    const added = await call(store, user, 'POST', `/api/feeds/${id}/sources`, {
      kind: 'spooool_channel',
      ref: 'cool',
    });
    expect(added.status).toBe(200);
    expect(added.json.source).toMatchObject({ kind: 'spooool_channel', ref: 'creator1', label: 'Cool Creator' });
  });

  it('rejects a spooool_channel for an unknown username', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'spooool_channel',
      ref: 'ghost',
    });
    expect(res.status).toBe(400);
  });

  it('adds a youtube_search source (no resolution needed)', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'youtube_search',
      ref: 'lofi beats',
    });
    expect(res.status).toBe(200);
    expect(res.json.source).toMatchObject({ kind: 'youtube_search', ref: 'lofi beats' });
  });

  it('validates a tiktok_video URL', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const ok = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'tiktok_video',
      ref: 'https://www.tiktok.com/@u/video/7300000000000000000',
    });
    expect(ok.status).toBe(200);
    const bad = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'tiktok_video',
      ref: 'https://example.com/x',
    });
    expect(bad.status).toBe(400);
  });

  it('rejects an unparseable youtube_playlist ref', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const res = await call(store, user, 'POST', `/api/feeds/${feed.json.feed.id}/sources`, {
      kind: 'youtube_playlist',
      ref: 'not a playlist',
    });
    expect(res.status).toBe(400);
  });

  it('only the owner can add or remove sources', async () => {
    const store = emptyStore();
    const owner = { id: 'owner' };
    const feed = await call(store, owner, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    const added = await call(store, owner, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'x' });
    const sid = added.json.source.id as string;

    expect((await call(store, { id: 'other' }, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'y' })).status).toBe(403);
    expect((await call(store, { id: 'other' }, 'DELETE', `/api/feeds/${id}/sources/${sid}`)).status).toBe(403);
    expect((await call(store, owner, 'DELETE', `/api/feeds/${id}/sources/${sid}`)).status).toBe(200);
  });
});
```

Note: `youtube_channel` add resolves via the network and is exercised in Task 8's assembly tests via injected fakes; the validation tests above cover the no-network kinds. For `youtube_channel`, `resolveSource` calls `resolveYouTubeChannel` — in these unit tests we avoid that kind because the route uses the real `fetch`. (Assembly tests inject fakes through the cache instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: FAIL — `POST /api/feeds/:id/sources` returns 404 (route not defined) so assertions fail.

- [ ] **Step 3: Add source routes + `resolveSource` to `src/workers/feeds.ts`**

Add this schema near the other schemas:

```ts
const addSourceSchema = z.object({
  kind: z.enum(['spooool_channel', 'youtube_channel', 'youtube_playlist', 'youtube_search', 'tiktok_video']),
  ref: z.string().min(1).max(2048),
});
```

Add this helper above `export const feedRoutes`:

```ts
// Validate + normalize a user-supplied source into the stored { ref, label }.
// Throws Error(message) on invalid input; the route maps that to a 400.
async function resolveSource(
  env: FeedsEnv,
  kind: FeedSourceKind,
  rawRef: string,
): Promise<{ ref: string; label: string }> {
  const ref = rawRef.trim();
  if (kind === 'spooool_channel') {
    const row = await env.DB.prepare(
      `SELECT id, COALESCE(displayName, name) AS label FROM user WHERE username = ?`,
    )
      .bind(ref)
      .first<{ id: string; label: string }>();
    if (!row) throw new Error('Unknown spooool channel');
    return { ref: row.id, label: row.label ?? ref };
  }
  if (kind === 'youtube_channel') {
    const parsed = parseChannelInput(ref);
    if (!parsed) throw new Error('Could not parse YouTube channel');
    const { channelId, title } = await resolveYouTubeChannel(env, parsed);
    return { ref: channelId, label: title };
  }
  if (kind === 'youtube_playlist') {
    const playlistId = parsePlaylistInput(ref);
    if (!playlistId) throw new Error('Could not parse YouTube playlist');
    const title = await resolveYouTubePlaylistTitle(env, playlistId);
    return { ref: playlistId, label: title };
  }
  if (kind === 'youtube_search') {
    return { ref, label: `Search: ${ref}` };
  }
  // tiktok_video
  if (!isTikTokVideoUrl(ref)) throw new Error('Not a TikTok video URL');
  return { ref, label: 'TikTok video' };
}
```

Add these routes after the DELETE feed route:

```ts
feedRoutes.post('/api/feeds/:id/sources', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const parsed = addSourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  let resolved: { ref: string; label: string };
  try {
    resolved = await resolveSource(c.env, parsed.data.kind, parsed.data.ref);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid source' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO feed_sources (id, feed_id, kind, ref, label) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, feed.id, parsed.data.kind, resolved.ref, resolved.label)
    .run();
  return c.json({ source: { id, kind: parsed.data.kind, ref: resolved.ref, label: resolved.label } });
});

feedRoutes.delete('/api/feeds/:id/sources/:sid', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  if (feed.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.prepare(`DELETE FROM feed_sources WHERE id = ? AND feed_id = ?`)
    .bind(c.req.param('sid'), feed.id)
    .run();
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: PASS (CRUD + sources blocks).

- [ ] **Step 5: Commit**

```bash
git add src/workers/feeds.ts src/workers/feeds.test.ts
git commit -m "feat(feeds): add source add/delete with per-kind validation + resolution"
```

---

## Task 8: `feeds.ts` — items assembly endpoint

**Files:**
- Modify: `src/workers/feeds.ts` (add `fetchSourceItems`, `assembleFeedSources`, and the `GET …/items` route)
- Test: `src/workers/feeds.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing tests**

Append to `src/workers/feeds.test.ts`. These pre-seed the KV cache so YouTube/TikTok resolve without network (`feeds.ts` reads the same per-source keys the clients write):

```ts
describe('feed items assembly', () => {
  function ytItem(id: string, publishedAt: number) {
    return {
      source: 'youtube', id, title: `t-${id}`, author: 'chan', thumbnailUrl: null,
      publishedAt, durationSec: null, url: `https://www.youtube.com/watch?v=${id}`,
      embed: { kind: 'youtube', videoId: id },
    };
  }

  it('merges spooool + cached youtube items newest-first and touches last_viewed_at', async () => {
    const store = emptyStore();
    store.users.push({ id: 'creator1', username: 'cool', label: 'Cool Creator' });
    store.videos.push({
      id: 'spv1', user_id: 'creator1', title: 'Spool One', thumbnail_url: null,
      created_at: '2026-03-01 00:00:00', author: 'Cool Creator',
    });
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'spooool_channel', ref: 'cool' });
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_channel', ref: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });

    // Pre-seed the per-source KV cache the YouTube client uses, so no network.
    const { env } = makeApp(store, user);
    await env.CACHE.put('yt:channel:UCX6OQ3DkcsbYNE6H8uQQuVA', JSON.stringify([ytItem('yt_new', Date.parse('2026-04-01T00:00:00Z'))]));

    const res = await callWith(env, store, user, 'GET', `/api/feeds/${id}/items`);
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: any) => i.id)).toEqual(['yt_new', 'spv1']);
    expect(store.feeds.find((f) => f.id === id)!.last_viewed_at).not.toBeNull();
  });

  it('keeps the feed alive when one source errors', async () => {
    const store = emptyStore();
    const user = { id: 'u1' };
    const feed = await call(store, user, 'POST', '/api/feeds', { name: 'F' });
    const id = feed.json.feed.id as string;
    await call(store, user, 'POST', `/api/feeds/${id}/sources`, { kind: 'youtube_search', ref: 'breaks' });

    const { env } = makeApp(store, user);
    // No cache seeded + search uses real fetch → produce path throws → error result,
    // but the endpoint must still return 200 with a per-source error flag.
    // Force the failure deterministically by stubbing fetch to reject.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    try {
      const res = await callWith(env, store, user, 'GET', `/api/feeds/${id}/items`);
      expect(res.status).toBe(200);
      expect(res.json.items).toEqual([]);
      expect(res.json.sources.some((s: any) => s.error)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

Add this helper next to `call` (it reuses a single `env` so the pre-seeded cache persists across the request):

```ts
async function callWith(env: FeedsEnv, store: Store, user: { id: string } | null, method: string, path: string, body?: unknown) {
  const { Hono } = require('hono');
  const app = new Hono();
  app.use('*', async (c: any, next: any) => { c.set('user', user); await next(); });
  app.route('/', feedRoutes);
  const req = new Request(`http://x${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.fetch(req, env);
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: FAIL — `GET /api/feeds/:id/items` route not defined (404).

- [ ] **Step 3: Add the assembly logic + route to `src/workers/feeds.ts`**

Add the items-query schema near the others:

```ts
const itemsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(24),
});
```

Add these helpers above `export const feedRoutes`:

```ts
const YT_PER_SOURCE = 15;

async function spoooolChannelItems(env: FeedsEnv, userId: string): Promise<FeedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.title, v.thumbnail_url, v.created_at, COALESCE(u.displayName, u.name) AS author
     FROM videos v LEFT JOIN user u ON u.id = v.user_id
     WHERE v.user_id = ? AND v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.dmca_status IS NULL
     ORDER BY v.created_at DESC LIMIT ?`,
  )
    .bind(userId, YT_PER_SOURCE)
    .all<{ id: string; title: string; thumbnail_url: string | null; created_at: string; author: string | null }>();
  return (results ?? []).map((r) => ({
    source: 'spooool' as const,
    id: r.id,
    title: r.title,
    author: r.author ?? 'spooool',
    thumbnailUrl: r.thumbnail_url,
    publishedAt: parseSqliteTimestamp(r.created_at),
    durationSec: null,
    url: `/watch/${r.id}`,
  }));
}

// Resolve one stored source row into a SourceResult. A failure degrades to an
// error result for that source only — never throws.
async function fetchSourceItems(env: FeedsEnv, s: SourceRow): Promise<SourceResult> {
  const base = { sourceId: s.id, kind: s.kind };
  try {
    if (s.kind === 'spooool_channel') {
      return { ...base, items: await spoooolChannelItems(env, s.ref) };
    }
    if (s.kind === 'youtube_channel') {
      const r = await getYouTubeChannelItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    if (s.kind === 'youtube_playlist') {
      const r = await getYouTubePlaylistItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    if (s.kind === 'youtube_search') {
      const r = await getYouTubeSearchItems(env, s.ref);
      return { ...base, items: r.items, error: r.error, stale: r.stale };
    }
    // tiktok_video
    const r = await getTikTokItem(env, s.ref, parseSqliteTimestamp(s.added_at));
    return { ...base, items: r.item ? [r.item] : [], error: r.error };
  } catch (err) {
    return { ...base, items: [], error: err instanceof Error ? err.message : 'source failed' };
  }
}
```

Add the route after the source routes:

```ts
feedRoutes.get('/api/feeds/:id/items', async (c) => {
  const feed = await loadFeed(c.env, c.req.param('id'));
  if (!feed) return c.json({ error: 'Feed not found' }, 404);
  const user = c.get('user');
  const isOwner = user?.id === feed.user_id;
  if (!feed.is_public && !isOwner) return c.json({ error: 'Feed not found' }, 404);

  const parsed = itemsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources WHERE feed_id = ? ORDER BY position ASC, added_at ASC`,
  )
    .bind(feed.id)
    .all<SourceRow>();
  const rows = results ?? [];

  const sourceResults = await Promise.all(rows.map((s) => fetchSourceItems(c.env, s)));
  const assembled = assembleFeed(sourceResults, parsed.data.cursor ?? null, parsed.data.limit);

  // Touch last_viewed_at so the cron warmer keeps this feed's caches fresh.
  await c.env.DB.prepare(`UPDATE feeds SET last_viewed_at = ? WHERE id = ?`)
    .bind(Date.now(), feed.id)
    .run();

  // Enrich the source summary with labels for the manage panel.
  const labelById = new Map(rows.map((r) => [r.id, r.label]));
  const sources = assembled.sources.map((s) => ({ ...s, label: labelById.get(s.sourceId) ?? '' }));

  return c.json({
    feed: { ...publicFeed(feed), is_owner: isOwner },
    items: assembled.items,
    nextCursor: assembled.nextCursor,
    sources,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/workers/feeds.ts src/workers/feeds.test.ts
git commit -m "feat(feeds): add merged items endpoint with graceful per-source degradation"
```

---

## Task 9: Wire `feeds.ts` into the worker + cron cache warming

**Files:**
- Modify: `src/workers/index.ts` (import + mount `feedRoutes`; add `YOUTUBE_API_KEY` to `EnvBindings`; call `warmFeedCaches` in the `*/5` cron)
- Create: `src/workers/feed-warm.ts` (the warmer)
- Test: `src/workers/feed-warm.test.ts`

- [ ] **Step 1: Write the failing test for the warmer**

Create `src/workers/feed-warm.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { warmFeedCaches, type FeedWarmEnv } from './feed-warm';

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

function fakeDB(rows: Array<{ kind: string; ref: string }>): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
    }),
  } as unknown as D1Database;
}

describe('warmFeedCaches', () => {
  it('refreshes only cheap channel/playlist sources for recently-viewed feeds', async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.includes('/channels')) {
        return new Response(JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;

    const env: FeedWarmEnv = {
      DB: fakeDB([
        { kind: 'youtube_channel', ref: 'UC1' },
        { kind: 'youtube_playlist', ref: 'PL1' },
      ]),
      CACHE: fakeKV(),
      YOUTUBE_API_KEY: 'k',
    };
    const count = await warmFeedCaches(env, fetcher);
    expect(count).toBe(2);
    expect(seen.some((u) => u.includes('/playlistItems'))).toBe(true);
  });

  it('is a no-op when YOUTUBE_API_KEY is missing', async () => {
    const env: FeedWarmEnv = { DB: fakeDB([{ kind: 'youtube_channel', ref: 'UC1' }]), CACHE: fakeKV() };
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await warmFeedCaches(env, fetcher)).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feed-warm.test.ts`
Expected: FAIL — `Cannot find module './feed-warm'`.

- [ ] **Step 3: Write `src/workers/feed-warm.ts`**

```ts
// Cron-driven cache warmer (called from the existing "*/5 * * * *" trigger).
// Refreshes ONLY cheap YouTube sources (channel uploads = ~1 quota unit,
// playlist = ~1) for feeds viewed in the last 7 days. Search (100 units) is
// deliberately NOT warmed — it refreshes lazily on view to protect quota.

import { getYouTubeChannelItems, getYouTubePlaylistItems, type YouTubeEnv } from './youtube';

export interface FeedWarmEnv extends YouTubeEnv {
  DB: D1Database;
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export async function warmFeedCaches(env: FeedWarmEnv, fetcher: typeof fetch = fetch): Promise<number> {
  if (!env.YOUTUBE_API_KEY) return 0;
  const since = Date.now() - RECENT_MS;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT fs.kind, fs.ref
     FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
     WHERE f.last_viewed_at IS NOT NULL AND f.last_viewed_at > ?
       AND fs.kind IN ('youtube_channel','youtube_playlist')`,
  )
    .bind(since)
    .all<{ kind: string; ref: string }>();

  let warmed = 0;
  for (const row of results ?? []) {
    try {
      if (row.kind === 'youtube_channel') await getYouTubeChannelItems(env, row.ref, fetcher, true);
      else await getYouTubePlaylistItems(env, row.ref, fetcher, true);
      warmed++;
    } catch {
      // best-effort; a failing source must not abort the sweep
    }
  }
  return warmed;
}
```

- [ ] **Step 4: Run the warmer test**

Run: `npx vitest run src/workers/feed-warm.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/workers/index.ts`**

Add imports near the other route imports (after the `tags` import, alphabetical-ish to match the file):

```ts
import { feedRoutes, type FeedsEnv } from './feeds';
import { warmFeedCaches } from './feed-warm';
```

Add `FeedsEnv` to the `EnvBindings` intersection and declare the secret. Change the `type EnvBindings = …` opening to include `FeedsEnv`:

```ts
type EnvBindings = AuthEnv & VideoRoutesEnv & RenderEnv & CreateEnv & StreamUploadEnv & FeedsEnv & {
```

and add this field inside that `& { … }` block (next to the other optional vars):

```ts
  // YouTube Data API v3 key for custom feeds (src/workers/youtube.ts). A
  // Cloudflare *secret* (Doppler-synced), NOT a [vars] entry. Optional so the
  // worker still boots without it; YouTube sources just return an error result.
  YOUTUBE_API_KEY?: string;
```

Mount the routes — add next to the other `app.route('/', …)` calls (e.g. right after `app.route('/', tagRoutes);`):

```ts
app.route('/', feedRoutes);
```

Call the warmer in the existing `*/5 * * * *` cron branch. Find this block in the `scheduled` handler:

```ts
          if (controller.cron === '*/5 * * * *') {
            // Frequent sweep: render-job timeout cleanup + abandoned create_sessions
            await runStuckJobSweep(env.DB);
            await runAbandonedSessionsSweep(env.DB);
            return;
          }
```

and change it to:

```ts
          if (controller.cron === '*/5 * * * *') {
            // Frequent sweep: render-job timeout cleanup + abandoned create_sessions
            await runStuckJobSweep(env.DB);
            await runAbandonedSessionsSweep(env.DB);
            // ALO-feeds: warm cheap YouTube source caches for recently-viewed feeds.
            const warmed = await warmFeedCaches(env);
            if (warmed > 0) console.log('[feed-warm]', { cron: controller.cron, warmed });
            return;
          }
```

- [ ] **Step 6: Verify the build type-checks and the suite passes**

Run: `npm run type-check`
Expected: no errors.

Run: `npx vitest run src/workers/ai-gateway.test.ts src/workers/feeds.test.ts src/workers/feed-warm.test.ts`
Expected: PASS (a quick proxy that `index.ts` still composes; full suite runs at the end).

- [ ] **Step 7: Commit**

```bash
git add src/workers/index.ts src/workers/feed-warm.ts src/workers/feed-warm.test.ts
git commit -m "feat(feeds): mount feedRoutes + warm YouTube caches on the */5 cron"
```

---

## Task 10: CSP — allow the YouTube nocookie embed frame

**Files:**
- Modify: `src/workers/security-headers.ts` (add `frame-src`)
- Test: `src/workers/security-headers.test.ts` (add an assertion)

- [ ] **Step 1: Write the failing test**

Add to `src/workers/security-headers.test.ts` (inside the existing top-level `describe`, or as a new `it`):

```ts
import { CSP_HEADER_VALUE } from './security-headers';

it('allows the YouTube nocookie embed frame and nothing else by default', () => {
  expect(CSP_HEADER_VALUE).toContain('frame-src https://www.youtube-nocookie.com');
});
```

(If `CSP_HEADER_VALUE` is already imported at the top of the file, don't duplicate the import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/security-headers.test.ts`
Expected: FAIL — `frame-src` not present.

- [ ] **Step 3: Add the directive**

In `src/workers/security-headers.ts`, add a `frame-src` entry to `CSP_DIRECTIVES` (place it after `media-src`):

```ts
  'frame-src': ['https://www.youtube-nocookie.com'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/security-headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/security-headers.ts src/workers/security-headers.test.ts
git commit -m "feat(feeds): allow youtube-nocookie frame-src in CSP"
```

---

## Task 11: Config documentation — `YOUTUBE_API_KEY` secret

**Files:**
- Modify: `wrangler.toml` (comment documenting the secret in the `[vars]` area)
- Modify: `doppler.yaml` (add the key so it syncs)

No test (config/docs only). The actual secret is set out-of-band via `wrangler secret put YOUTUBE_API_KEY` — document that.

- [ ] **Step 1: Document the secret in `wrangler.toml`**

In `wrangler.toml`, just above the `[vars]` section, add a comment:

```toml
# YOUTUBE_API_KEY is a SECRET, not a [vars] entry. Set it with:
#   wrangler secret put YOUTUBE_API_KEY            (prod)
#   wrangler secret put YOUTUBE_API_KEY --env staging
# Used by src/workers/youtube.ts for custom multi-source feeds. TikTok needs
# no credentials (public oEmbed). Neither is a model provider, so neither
# routes through the AI Gateway.
```

- [ ] **Step 2: Add the key to `doppler.yaml`**

Open `doppler.yaml` and add `YOUTUBE_API_KEY` to the secrets list following the existing format in that file (match the surrounding indentation/structure — add it alongside the other worker secret entries). If the file lists secrets under a mapping, add:

```yaml
  YOUTUBE_API_KEY: ""
```

(Use the exact shape the file already uses for other secrets; the goal is that `doppler run` / sync includes the key.)

- [ ] **Step 3: Verify nothing breaks**

Run: `npm run type-check`
Expected: no errors (config-only change).

- [ ] **Step 4: Commit**

```bash
git add wrangler.toml doppler.yaml
git commit -m "docs(feeds): document YOUTUBE_API_KEY secret + doppler sync"
```

---

## Task 12: Frontend API client — `feeds-client.ts`

**Files:**
- Create: `src/frontend/lib/feeds-client.ts`
- Test: `src/frontend/lib/feeds-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/lib/feeds-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeed, listFeeds, addSource, fetchFeedItems } from './feeds-client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });

function mockOnce(body: unknown, ok = true, status = 200): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok, status, json: async () => body,
  });
}

describe('feeds-client', () => {
  it('createFeed posts name + public flag', async () => {
    mockOnce({ feed: { id: 'f1', name: 'X', is_public: 0 } });
    const feed = await createFeed({ name: 'X' });
    expect(feed.id).toBe('f1');
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('/api/feeds');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'X' });
  });

  it('listFeeds returns the feeds array', async () => {
    mockOnce({ feeds: [{ id: 'f1', name: 'X', is_public: 0 }] });
    expect(await listFeeds()).toHaveLength(1);
  });

  it('addSource posts kind + ref', async () => {
    mockOnce({ source: { id: 's1', kind: 'youtube_search', ref: 'cats', label: 'Search: cats' } });
    const s = await addSource('f1', { kind: 'youtube_search', ref: 'cats' });
    expect(s.kind).toBe('youtube_search');
  });

  it('fetchFeedItems returns items + nextCursor', async () => {
    mockOnce({ feed: { id: 'f1', name: 'X' }, items: [{ source: 'youtube', id: 'v' }], nextCursor: null, sources: [] });
    const out = await fetchFeedItems('f1');
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it('throws on a non-ok response', async () => {
    mockOnce({ error: 'nope' }, false, 400);
    await expect(createFeed({ name: '' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/lib/feeds-client.test.ts`
Expected: FAIL — `Cannot find module './feeds-client'`.

- [ ] **Step 3: Write the client**

Create `src/frontend/lib/feeds-client.ts`:

```ts
// Typed fetch wrappers for the custom-feeds API. Mirrors the shapes returned
// by src/workers/feeds.ts. All calls use same-origin credentials so the
// better-auth session cookie is sent.

export type FeedSourceKind =
  | 'spooool_channel' | 'youtube_channel' | 'youtube_playlist' | 'youtube_search' | 'tiktok_video';

export interface Feed {
  id: string;
  name: string;
  description: string;
  is_public: number;
  is_owner?: boolean;
}

export interface FeedSource {
  id: string;
  kind: FeedSourceKind;
  ref: string;
  label: string;
}

export interface FeedItem {
  source: 'spooool' | 'youtube' | 'tiktok';
  id: string;
  title: string;
  author: string;
  thumbnailUrl: string | null;
  publishedAt: number;
  durationSec: number | null;
  url: string;
  embed?: { kind: 'youtube'; videoId: string };
}

export interface FeedItemsResponse {
  feed: Feed;
  items: FeedItem[];
  nextCursor: string | null;
  sources: Array<{ sourceId: string; kind: FeedSourceKind; label: string; error?: string; stale?: boolean }>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const opts = (method: string, body?: unknown): RequestInit => ({
  method,
  credentials: 'same-origin',
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

export async function createFeed(input: { name: string; description?: string; is_public?: boolean }): Promise<Feed> {
  const { feed } = await json<{ feed: Feed }>(await fetch('/api/feeds', opts('POST', input)));
  return feed;
}

export async function listFeeds(): Promise<Feed[]> {
  const { feeds } = await json<{ feeds: Feed[] }>(await fetch('/api/feeds', opts('GET')));
  return feeds;
}

export async function getFeed(id: string): Promise<{ feed: Feed; sources: FeedSource[] }> {
  return json<{ feed: Feed; sources: FeedSource[] }>(await fetch(`/api/feeds/${id}`, opts('GET')));
}

export async function updateFeed(id: string, patch: { name?: string; description?: string; is_public?: boolean }): Promise<Feed> {
  const { feed } = await json<{ feed: Feed }>(await fetch(`/api/feeds/${id}`, opts('PATCH', patch)));
  return feed;
}

export async function deleteFeed(id: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/feeds/${id}`, opts('DELETE')));
}

export async function addSource(feedId: string, input: { kind: FeedSourceKind; ref: string }): Promise<FeedSource> {
  const { source } = await json<{ source: FeedSource }>(await fetch(`/api/feeds/${feedId}/sources`, opts('POST', input)));
  return source;
}

export async function removeSource(feedId: string, sourceId: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/feeds/${feedId}/sources/${sourceId}`, opts('DELETE')));
}

export async function fetchFeedItems(feedId: string, cursor?: string): Promise<FeedItemsResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return json<FeedItemsResponse>(await fetch(`/api/feeds/${feedId}/items${qs}`, opts('GET')));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/frontend/lib/feeds-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/lib/feeds-client.ts src/frontend/lib/feeds-client.test.ts
git commit -m "feat(feeds): add typed frontend feeds API client"
```

---

## Task 13: `YouTubeEmbed` component (click-to-load nocookie iframe)

**Files:**
- Create: `src/frontend/components/YouTubeEmbed.tsx`
- Test: `src/frontend/components/YouTubeEmbed.dom.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/components/YouTubeEmbed.dom.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { YouTubeEmbed } from './YouTubeEmbed';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(el));
}

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('YouTubeEmbed', () => {
  it('shows a thumbnail button first and no iframe', () => {
    mount(<YouTubeEmbed videoId="abc123" title="Cool" thumbnailUrl="https://i/x.jpg" />);
    expect(container!.querySelector('iframe')).toBeNull();
    expect(container!.querySelector('button')).not.toBeNull();
  });

  it('loads the nocookie iframe after a click', () => {
    mount(<YouTubeEmbed videoId="abc123" title="Cool" thumbnailUrl="https://i/x.jpg" />);
    act(() => {
      container!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const iframe = container!.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('src')).toContain('https://www.youtube-nocookie.com/embed/abc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/components/YouTubeEmbed.dom.test.tsx`
Expected: FAIL — `Cannot find module './YouTubeEmbed'`.

- [ ] **Step 3: Write the component**

Create `src/frontend/components/YouTubeEmbed.tsx`:

```tsx
import { useState } from 'react';

interface YouTubeEmbedProps {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
}

// Privacy- and performance-friendly: render only a thumbnail until the user
// clicks, then swap in the youtube-nocookie iframe. No YouTube JS is loaded,
// so the CSP only needs frame-src https://www.youtube-nocookie.com.
export function YouTubeEmbed({ videoId, title, thumbnailUrl }: YouTubeEmbedProps): JSX.Element {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="feed-embed feed-embed--youtube">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 8 }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="feed-embed feed-embed--placeholder"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${title}`}
      style={{
        position: 'relative', width: '100%', aspectRatio: '16 / 9', padding: 0, border: 0,
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
        background: thumbnailUrl ? `center / cover no-repeat url(${thumbnailUrl})` : '#000',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        background: 'rgba(0,0,0,0.25)', color: '#fff', fontSize: 48,
      }}>▶</span>
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/frontend/components/YouTubeEmbed.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/components/YouTubeEmbed.tsx src/frontend/components/YouTubeEmbed.dom.test.tsx
git commit -m "feat(feeds): add click-to-load YouTube nocookie embed component"
```

---

## Task 14: `FeedItemCard` component (renders per source)

**Files:**
- Create: `src/frontend/components/FeedItemCard.tsx`
- Test: `src/frontend/components/FeedItemCard.dom.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/components/FeedItemCard.dom.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { FeedItemCard } from './FeedItemCard';
import type { FeedItem } from '../lib/feeds-client';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
}

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

function item(over: Partial<FeedItem>): FeedItem {
  return {
    source: 'youtube', id: 'x', title: 'T', author: 'A', thumbnailUrl: 'https://i/x.jpg',
    publishedAt: Date.now(), durationSec: null, url: 'https://example.com/x', ...over,
  };
}

describe('FeedItemCard', () => {
  it('renders a spooool item as an internal /watch link', () => {
    mount(<FeedItemCard item={item({ source: 'spooool', id: 'spv1', url: '/watch/spv1' })} />);
    const a = container!.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/watch/spv1');
  });

  it('renders a youtube item with a play button (embed component)', () => {
    mount(<FeedItemCard item={item({ source: 'youtube', embed: { kind: 'youtube', videoId: 'abc' } })} />);
    expect(container!.querySelector('button[aria-label^="Play"]')).not.toBeNull();
  });

  it('renders a tiktok item as an external link that opens in a new tab', () => {
    mount(<FeedItemCard item={item({ source: 'tiktok', url: 'https://www.tiktok.com/@u/video/7' })} />);
    const a = container!.querySelector('a[target="_blank"]');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('rel')).toContain('noopener');
    expect(a!.getAttribute('href')).toBe('https://www.tiktok.com/@u/video/7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/components/FeedItemCard.dom.test.tsx`
Expected: FAIL — `Cannot find module './FeedItemCard'`.

- [ ] **Step 3: Write the component**

Create `src/frontend/components/FeedItemCard.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { FeedItem } from '../lib/feeds-client';
import { YouTubeEmbed } from './YouTubeEmbed';

function SourceBadge({ source }: { source: FeedItem['source'] }): JSX.Element {
  const label = source === 'spooool' ? 'spooool' : source === 'youtube' ? 'YouTube' : 'TikTok';
  return <span className={`feed-badge feed-badge--${source}`}>{label}</span>;
}

function Meta({ item }: { item: FeedItem }): JSX.Element {
  return (
    <div className="feed-card__meta">
      <SourceBadge source={item.source} />
      <h3 className="feed-card__title">{item.title}</h3>
      <p className="ds-meta feed-card__author">{item.author}</p>
    </div>
  );
}

export function FeedItemCard({ item }: { item: FeedItem }): JSX.Element {
  // spooool: internal watch route (Stream player lives there).
  if (item.source === 'spooool') {
    return (
      <article className="feed-card feed-card--spooool">
        <Link to={item.url} className="feed-card__thumb-link">
          {item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt="" className="feed-card__thumb" loading="lazy" />
          ) : (
            <div className="feed-card__thumb feed-card__thumb--empty" />
          )}
        </Link>
        <Meta item={item} />
      </article>
    );
  }

  // youtube: inline click-to-load embed.
  if (item.source === 'youtube' && item.embed) {
    return (
      <article className="feed-card feed-card--youtube">
        <YouTubeEmbed videoId={item.embed.videoId} title={item.title} thumbnailUrl={item.thumbnailUrl} />
        <Meta item={item} />
      </article>
    );
  }

  // tiktok (and any non-embeddable item): card that links out.
  return (
    <article className="feed-card feed-card--tiktok">
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="feed-card__thumb-link">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="feed-card__thumb" loading="lazy" />
        ) : (
          <div className="feed-card__thumb feed-card__thumb--empty" />
        )}
      </a>
      <Meta item={item} />
    </article>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/frontend/components/FeedItemCard.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/components/FeedItemCard.tsx src/frontend/components/FeedItemCard.dom.test.tsx
git commit -m "feat(feeds): add FeedItemCard rendering per source"
```

---

## Task 15: `Feeds` page (list + create) + route + nav

**Files:**
- Create: `src/frontend/pages/Feeds.tsx`
- Test: `src/frontend/pages/Feeds.dom.test.tsx`
- Modify: `src/frontend/App.tsx` (lazy import + protected route + nav link)

- [ ] **Step 1: Write the failing test**

Create `src/frontend/pages/Feeds.dom.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { Feeds } from './Feeds';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mount(el: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('Feeds page', () => {
  it('lists feeds returned by the API', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ feeds: [{ id: 'f1', name: 'Morning Watch', is_public: 0 }] }) });
    mount(<Feeds />);
    await flush();
    expect(container!.textContent).toContain('Morning Watch');
  });

  it('shows an empty state when there are no feeds', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ feeds: [] }) });
    mount(<Feeds />);
    await flush();
    expect(container!.textContent?.toLowerCase()).toContain('no feeds');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/pages/Feeds.dom.test.tsx`
Expected: FAIL — `Cannot find module './Feeds'`.

- [ ] **Step 3: Write the page**

Create `src/frontend/pages/Feeds.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createFeed, listFeeds, type Feed } from '../lib/feeds-client';

export function Feeds(): JSX.Element {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void listFeeds()
      .then((f) => { if (!cancelled) setFeeds(f); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load feeds'); });
    return () => { cancelled = true; };
  }, []);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const feed = await createFeed({ name: name.trim() });
      navigate(`/feeds/${feed.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create feed');
      setCreating(false);
    }
  }

  return (
    <main className="app-main stack-lg fade-in">
      <h1 className="ds-h2" style={{ margin: 0 }}>Your Feeds</h1>
      <p className="ds-meta" style={{ margin: 0 }}>
        Mix spooool channels, YouTube, and TikTok into one custom stream.
      </p>

      <form onSubmit={onCreate} className="stack-sm" style={{ maxWidth: 420 }}>
        <input
          className="ds-input"
          placeholder="New feed name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          aria-label="New feed name"
        />
        <button type="submit" className="ds-btn" disabled={!name.trim() || creating}>
          {creating ? 'Creating…' : 'Create feed'}
        </button>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
      {feeds === null && !error ? <p className="ds-empty">Loading…</p> : null}

      {feeds !== null && feeds.length === 0 ? (
        <p className="ds-empty">No feeds yet — create one above.</p>
      ) : null}

      {feeds !== null && feeds.length > 0 ? (
        <ul className="feed-list stack-sm" style={{ listStyle: 'none', padding: 0 }}>
          {feeds.map((f) => (
            <li key={f.id}>
              <Link to={`/feeds/${f.id}`} className="feed-list__item">
                <span className="feed-list__name">{f.name}</span>
                {f.is_public ? <span className="feed-badge">Public</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/frontend/pages/Feeds.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Register the route + nav link in `src/frontend/App.tsx`**

Add the lazy import alongside the other `lazy(...)` page imports:

```tsx
const Feeds = lazy(() => import('./pages/Feeds').then((m) => ({ default: m.Feeds })));
const FeedView = lazy(() => import('./pages/FeedView').then((m) => ({ default: m.FeedView })));
```

(The `FeedView` import is used in Task 16; adding it now keeps the import block in one edit.)

Add the protected routes inside `<Routes>` (next to the other `RequireAuth` routes such as `/subscriptions`):

```tsx
          <Route
            path="/feeds"
            element={
              <RequireAuth>
                <Feeds />
              </RequireAuth>
            }
          />
          <Route path="/feeds/:id" element={<FeedView />} />
```

Note: `/feeds/:id` is intentionally **not** wrapped in `RequireAuth` so public feeds are viewable while signed out; the API enforces private-feed access.

Add a nav link in the authenticated nav (near the existing `<Link to="/subscriptions">` around line 227 of `App.tsx`):

```tsx
      <Link to="/feeds">Feeds</Link>
```

- [ ] **Step 6: Verify build + route test**

Run: `npm run type-check`
Expected: no errors (note: `FeedView` page is created in Task 16; if you run type-check before Task 16, temporarily expect a missing-module error on the `FeedView` import — complete Task 16 before the final full type-check). To keep this task self-contained and green, create a minimal placeholder now and replace it in Task 16:

If running type-check before Task 16, first create a stub `src/frontend/pages/FeedView.tsx`:

```tsx
export function FeedView(): JSX.Element {
  return <main className="app-main" />;
}
```

- [ ] **Step 7: Commit**

```bash
git add src/frontend/pages/Feeds.tsx src/frontend/pages/Feeds.dom.test.tsx src/frontend/App.tsx src/frontend/pages/FeedView.tsx
git commit -m "feat(feeds): add Feeds list/create page + routes + nav link"
```

---

## Task 16: `FeedView` page (merged grid + manage sources)

**Files:**
- Modify/Create: `src/frontend/pages/FeedView.tsx` (replace the Task 15 stub with the full page)
- Test: `src/frontend/pages/FeedView.dom.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/pages/FeedView.dom.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { FeedView } from './FeedView';

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

function mountAt(path: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/feeds/:id" element={<FeedView />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root) { act(() => root!.unmount()); root = null; }
  if (container) { container.remove(); container = null; }
});

describe('FeedView page', () => {
  it('renders the feed name and its items', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        feed: { id: 'f1', name: 'Morning Watch', is_public: 0, is_owner: true },
        items: [
          { source: 'youtube', id: 'y1', title: 'YT Vid', author: 'C', thumbnailUrl: null, publishedAt: 2, durationSec: null, url: 'u', embed: { kind: 'youtube', videoId: 'y1' } },
          { source: 'tiktok', id: 't1', title: 'TT Vid', author: 'D', thumbnailUrl: null, publishedAt: 1, durationSec: null, url: 'https://www.tiktok.com/@d/video/1' },
        ],
        nextCursor: null,
        sources: [],
      }),
    });
    mountAt('/feeds/f1');
    await flush();
    expect(container!.textContent).toContain('Morning Watch');
    expect(container!.textContent).toContain('YT Vid');
    expect(container!.textContent).toContain('TT Vid');
  });

  it('surfaces a stale/error chip from the sources summary', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        feed: { id: 'f1', name: 'F', is_public: 0, is_owner: true },
        items: [],
        nextCursor: null,
        sources: [{ sourceId: 's1', kind: 'youtube_search', label: 'Search: x', error: 'quotaExceeded' }],
      }),
    });
    mountAt('/feeds/f1');
    await flush();
    expect(container!.textContent?.toLowerCase()).toContain('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/pages/FeedView.dom.test.tsx`
Expected: FAIL — the stub `FeedView` renders nothing, so text assertions fail.

- [ ] **Step 3: Write the full page (replace the Task 15 stub)**

Replace the contents of `src/frontend/pages/FeedView.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  addSource,
  fetchFeedItems,
  removeSource,
  type FeedItem,
  type FeedItemsResponse,
  type FeedSourceKind,
} from '../lib/feeds-client';
import { FeedItemCard } from '../components/FeedItemCard';

const SOURCE_KINDS: Array<{ kind: FeedSourceKind; label: string; placeholder: string }> = [
  { kind: 'spooool_channel', label: 'spooool channel', placeholder: 'spooool username' },
  { kind: 'youtube_channel', label: 'YouTube channel', placeholder: 'channel URL or @handle' },
  { kind: 'youtube_playlist', label: 'YouTube playlist', placeholder: 'playlist URL' },
  { kind: 'youtube_search', label: 'YouTube search', placeholder: 'search terms' },
  { kind: 'tiktok_video', label: 'TikTok video', placeholder: 'tiktok.com video URL' },
];

export function FeedView(): JSX.Element {
  const { id = '' } = useParams();
  const [data, setData] = useState<FeedItemsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<FeedSourceKind>('youtube_channel');
  const [ref, setRef] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchFeedItems(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed');
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void fetchFeedItems(id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load feed'); });
    return () => { cancelled = true; };
  }, [id]);

  async function onAddSource(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ref.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      await addSource(id, { kind, ref: ref.trim() });
      setRef('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add source');
    } finally {
      setAdding(false);
    }
  }

  async function onRemoveSource(sourceId: string): Promise<void> {
    try {
      await removeSource(id, sourceId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source');
    }
  }

  const isOwner = data?.feed.is_owner === true;

  return (
    <main className="app-main stack-lg fade-in">
      <h1 className="ds-h2" style={{ margin: 0 }}>{data?.feed.name ?? 'Feed'}</h1>
      {data?.feed.description ? <p className="ds-meta">{data.feed.description}</p> : null}

      {error ? <p className="status-error">{error}</p> : null}

      {isOwner ? (
        <section className="stack-sm" aria-label="Manage sources">
          <form onSubmit={onAddSource} className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select className="ds-input" value={kind} onChange={(e) => setKind(e.target.value as FeedSourceKind)} aria-label="Source type">
              {SOURCE_KINDS.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
            </select>
            <input
              className="ds-input"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder={SOURCE_KINDS.find((s) => s.kind === kind)?.placeholder}
              aria-label="Source reference"
              style={{ flex: 1, minWidth: 200 }}
            />
            <button type="submit" className="ds-btn" disabled={!ref.trim() || adding}>
              {adding ? 'Adding…' : 'Add source'}
            </button>
          </form>

          {data && data.sources.length > 0 ? (
            <ul className="feed-sources" style={{ listStyle: 'none', padding: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {data.sources.map((s) => (
                <li key={s.sourceId} className={`feed-source-chip${s.error ? ' feed-source-chip--error' : ''}${s.stale ? ' feed-source-chip--stale' : ''}`}>
                  <span>{s.label || s.kind}</span>
                  {s.error ? <span className="ds-meta"> · unavailable</span> : s.stale ? <span className="ds-meta"> · cached</span> : null}
                  <button type="button" aria-label={`Remove ${s.label || s.kind}`} onClick={() => onRemoveSource(s.sourceId)} style={{ marginLeft: 6 }}>×</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {data === null && !error ? <p className="ds-empty">Loading…</p> : null}

      {data !== null && data.items.length === 0 ? (
        <p className="ds-empty">No videos yet. {isOwner ? 'Add a source above to start filling this feed.' : ''}</p>
      ) : null}

      {data !== null && data.items.length > 0 ? (
        <div className="feed-grid" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {data.items.map((item: FeedItem) => (
            <FeedItemCard key={`${item.source}:${item.id}`} item={item} />
          ))}
        </div>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/frontend/pages/FeedView.dom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/pages/FeedView.tsx src/frontend/pages/FeedView.dom.test.tsx
git commit -m "feat(feeds): add FeedView page with merged grid + source management"
```

---

## Task 17: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Type-check the whole project**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 2: Run the provider guard (must stay green)**

Run: `npm run lint:no-providers`
Expected: exit 0 — YouTube/TikTok endpoints are not forbidden patterns.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (fix any oxlint findings in the new files).

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: all tests pass, including `feed-item`, `youtube`, `tiktok`, `feeds`, `feed-warm`, `security-headers`, `feeds-client`, `YouTubeEmbed`, `FeedItemCard`, `Feeds`, `FeedView`, and the existing suite.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Vite build succeeds (the new lazy routes are code-split).

- [ ] **Step 6: Final commit (if lint/format adjusted anything)**

```bash
git add -A
git commit -m "chore(feeds): lint/format pass for multi-source feeds" || echo "nothing to commit"
```

---

## Post-merge operational steps (not code — do once after deploy)

1. Create a YouTube Data API v3 key in Google Cloud Console (enable "YouTube Data API v3"), restrict it to that API.
2. Store it in Doppler and push to the worker:
   - `wrangler secret put YOUTUBE_API_KEY` (paste the key)
   - `wrangler secret put YOUTUBE_API_KEY --env staging`
3. Apply the migration:
   - `npm run db:migrate:staging` then verify, then `npm run db:migrate`.
4. Smoke test: create a feed, add a known YouTube channel (e.g. `@MrBeast`), a search term, and a TikTok video URL; confirm the merged grid renders and the YouTube embed plays on click.

---

## Self-Review

**Spec coverage:**
- Feeds CRUD + private/public → Tasks 1, 6. ✅
- Five source kinds + per-kind validation → Tasks 6–7 (schema CHECK in Task 1). ✅
- Merged/sorted/paginated items → Tasks 2, 8. ✅
- Per-source KV cache shared across feeds + quota degradation → Task 4. ✅
- TikTok oEmbed cards → Tasks 5, 14. ✅
- YouTube inline nocookie embed → Tasks 13, 14; CSP frame-src → Task 10. ✅
- spooool items via Stream `/watch` → Task 14 (`/watch/:id` Link). ✅
- Cron warm bounded to recently-viewed feeds, cheap sources only → Task 9. ✅
- `YOUTUBE_API_KEY` secret (not vars), Doppler-synced → Tasks 9 (type), 11 (config). ✅
- Graceful degradation (one source fails, feed survives) → Tasks 8 (test), 16 (UI chip). ✅
- `lint:no-providers` unaffected → Task 17 step 2. ✅
- Frontend list/create + view + manage → Tasks 15, 16. ✅
- Phase 2 seams (kinds/oauth) — schema CHECK + resolveSource switch are the extension points; no Phase 2 code (correct per spec non-goals).

**Placeholder scan:** No "TBD"/"implement later"/"add error handling" — every code step has complete code. The only intentional stub is the `FeedView` placeholder in Task 15, explicitly replaced in Task 16.

**Type consistency:** `FeedItem`/`SourceResult`/`FeedSourceKind` defined in `feed-item.ts` (Task 2) and reused unchanged in `youtube.ts`, `tiktok.ts`, `feeds.ts`. Frontend re-declares matching shapes in `feeds-client.ts` (Task 12) and imports `FeedItem` into components (Tasks 13–16). `YouTubeEnv`/`TikTokEnv`/`FeedsEnv`/`FeedWarmEnv` interfaces compose consistently. Cache keys (`yt:channel:`, `yt:playlist:`, `yt:search:`, `yt:uploads:`, `tt:video:`) are written by the clients (Tasks 4–5) and pre-seeded identically in the assembly tests (Task 8). Function names (`getYouTubeChannelItems`, `getYouTubePlaylistItems`, `getYouTubeSearchItems`, `resolveYouTubeChannel`, `resolveYouTubePlaylistTitle`, `getTikTokItem`, `isTikTokVideoUrl`, `assembleFeed`, `parseSqliteTimestamp`, `warmFeedCaches`) match across definitions and call sites.
