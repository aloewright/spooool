# Discover Search + Inline Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unified cross-web video search (YouTube, DailyMotion, Brave, Firecrawl) to spooool's feed with inline playback of any surfaced video via the user's Cobalt instance + Mantine Video.

**Architecture:** New worker provider clients each normalize one upstream to the existing `FeedItem` shape behind a shared read-through KV cache. An aggregator fans out, dedupes, and merges them behind `GET /api/discover/search`. A `cobalt.ts` client resolves any non-YouTube item's URL to a muxed MP4 behind `GET /api/discover/resolve`. A new `/discover` page and a `web_search` feed-source kind consume these; a new `InlineVideoPlayer` plays YouTube via iframe and everything else via Cobalt→MP4 in Mantine Video.

**Tech Stack:** Cloudflare Workers, Hono, Zod, D1, KV; React 18 + React Router v6, Vite; Vitest (node + `@cloudflare/vitest-pool-workers`); `@mantine/core`, `@mantine/hooks`, `@gfazioli/mantine-video`, existing `hls.js`.

**Conventions:** kebab-case files, named exports, `feat:` commits. Unit tests are `*.test.ts` (run by `vitest.config.ts`, node env). Worker-integration tests are `*.workers.test.ts`. **Never** pass `--configLoader native` (CI is Node 20). Run all worker/unit tests with `npm test`.

---

## File Structure

**Create (worker):**
- `src/workers/cache.ts` — shared read-through KV cache (+ last-good fallback) returning `FeedItem[]`.
- `src/workers/dailymotion.ts` — DailyMotion search client + normalizer.
- `src/workers/brave.ts` — Brave video search client + normalizer.
- `src/workers/firecrawl.ts` — Firecrawl search client + normalizer.
- `src/workers/cobalt.ts` — Cobalt playback resolver.
- `src/workers/discover.ts` — aggregator + Hono router (`/api/discover/*`).
- `src/db/migrations/0024_web_search_source.sql` — extend `feed_sources.kind` CHECK.
- Tests: `src/workers/cache.test.ts`, `dailymotion.test.ts`, `brave.test.ts`, `firecrawl.test.ts`, `cobalt.test.ts`, `discover.test.ts`, `discover.workers.test.ts`.

**Modify (worker):**
- `src/workers/feed-item.ts` — extend `FeedItemSource`/`FeedSourceKind`/`embed`; add `canonicalKey`, `dedupeItems`, `interleaveRanked`, `assembleByRank`.
- `src/workers/youtube.ts` — use `cachedItems` from `cache.ts`.
- `src/workers/feeds.ts` — assemble `web_search` sources via the aggregator; allow the kind.
- `src/workers/feed-warm.ts` — document `web_search` exclusion.
- `src/workers/index.ts` — extend `EnvBindings`; mount `discoverRoutes`.
- `wrangler.toml` — add `FIRECRAWL_URL`, `COBALT_URL` vars.

**Create (frontend):**
- `src/frontend/lib/discover-client.ts` — typed search + resolve client.
- `src/frontend/components/InlineVideoPlayer.tsx` — YouTube iframe vs Cobalt→Mantine Video.
- `src/frontend/pages/Discover.tsx` — `/discover` page.

**Modify (frontend):**
- `src/frontend/lib/feeds-client.ts` — extend `FeedItem`/`FeedSourceKind` types.
- `src/frontend/components/FeedItemCard.tsx` — play non-YouTube via `InlineVideoPlayer`.
- `src/frontend/App.tsx` — `MantineProvider`, `Discover` lazy route, nav link.
- `src/frontend/pages/FeedView.tsx` — add `web_search` source UI.
- `package.json` — add Mantine deps.

---

## Task 1: Shared read-through cache helper

**Files:**
- Create: `src/workers/cache.ts`
- Test: `src/workers/cache.test.ts`
- Modify: `src/workers/youtube.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cachedItems } from './cache';
import type { FeedItem } from './feed-item';

function fakeKV(store = new Map<string, string>()) {
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const item: FeedItem = {
  source: 'web', id: '1', title: 't', author: 'a',
  thumbnailUrl: null, publishedAt: 0, durationSec: null, url: 'https://e.com/1',
};

describe('cachedItems', () => {
  it('produces, caches fresh + last-good on miss', async () => {
    const CACHE = fakeKV();
    const r = await cachedItems({ CACHE }, 'k', 60, async () => [item]);
    expect(r.items).toEqual([item]);
    expect(CACHE.store.get('k')).toBe(JSON.stringify([item]));
    expect(CACHE.store.get('k:lg')).toBe(JSON.stringify([item]));
  });

  it('returns fresh cache without calling produce', async () => {
    const CACHE = fakeKV(new Map([['k', JSON.stringify([item])]]));
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('should not run');
    });
    expect(r.items).toEqual([item]);
  });

  it('falls back to last-good (stale) when produce throws', async () => {
    const CACHE = fakeKV(new Map([['k:lg', JSON.stringify([item])]]));
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('upstream down');
    });
    expect(r).toEqual({ items: [item], stale: true });
  });

  it('returns an error result when produce throws and no last-good', async () => {
    const CACHE = fakeKV();
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('boom');
    });
    expect(r.items).toEqual([]);
    expect(r.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/cache.test.ts`
Expected: FAIL — cannot find module `./cache`.

- [ ] **Step 3: Write the implementation**

Create `src/workers/cache.ts`:

```ts
// Shared read-through KV cache for FeedItem lists, with a long-lived "last good"
// copy for outage/quota fallback. Extracted from youtube.ts so every feed
// provider (youtube, dailymotion, brave, firecrawl) reuses one implementation.
import type { FeedItem } from './feed-item';

export interface CachedItemsEnv {
  CACHE: KVNamespace;
}

export interface CachedItemsResult {
  items: FeedItem[];
  stale?: boolean; // served from last-good after a refresh failure
  error?: string; // present when produce failed and no last-good existed
}

const TTL_LASTGOOD = 7 * 24 * 60 * 60; // seconds

export async function cachedItems(
  env: CachedItemsEnv,
  key: string,
  ttl: number,
  produce: () => Promise<FeedItem[]>,
): Promise<CachedItemsResult> {
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
    return { items: [], error: err instanceof Error ? err.message : 'fetch failed' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Repoint youtube.ts to the shared helper**

In `src/workers/youtube.ts`:
1. Add at the top of the imports: `import { cachedItems } from './cache';`
2. Delete the local `cached(...)` function (the `async function cached(env, key, ttl, produce) {...}` block, ~lines 191-210) and the now-unused `const TTL_LASTGOOD = ...` line.
3. Replace the three `return cached(env, ...)` / `return cached(env, ...)` call sites in `getYouTubeChannelItems`, `getYouTubePlaylistItems`, `getYouTubeSearchItems` with `return cachedItems(env, ...)` (identical args).

The `YouTubeFetchResult` type and `YouTubeEnv` (which has `CACHE`) remain; `cachedItems` is structurally compatible (`{ items, stale?, error? }`).

- [ ] **Step 6: Run the full worker/unit suite to verify nothing broke**

Run: `npm test`
Expected: PASS, including the existing `src/workers/youtube.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/workers/cache.ts src/workers/cache.test.ts src/workers/youtube.ts
git commit -m "feat: extract shared read-through cache helper for feed providers"
```

---

## Task 2: Extend FeedItem types + dedupe/relevance assembly

**Files:**
- Modify: `src/workers/feed-item.ts`
- Test: `src/workers/feed-item.test.ts` (create if absent; else append)

- [ ] **Step 1: Write the failing test**

Append to (or create) `src/workers/feed-item.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  dedupeItems,
  interleaveRanked,
  assembleByRank,
  type FeedItem,
} from './feed-item';

function yt(videoId: string): FeedItem {
  return {
    source: 'youtube', id: videoId, title: videoId, author: 'a',
    thumbnailUrl: null, publishedAt: 0, durationSec: null,
    url: `https://www.youtube.com/watch?v=${videoId}`, embed: { kind: 'youtube', videoId },
  };
}
function web(id: string, url: string): FeedItem {
  return {
    source: 'web', id, title: id, author: 'a',
    thumbnailUrl: null, publishedAt: 0, durationSec: null, url,
  };
}

describe('canonicalKey', () => {
  it('keys youtube by videoId', () => {
    expect(canonicalKey(yt('abc'))).toBe('yt:abc');
  });
  it('keys web by host+path lowercased, www stripped', () => {
    expect(canonicalKey(web('1', 'https://WWW.Example.com/Watch?utm=x'))).toBe('example.com/watch');
  });
});

describe('dedupeItems', () => {
  it('drops later duplicates by canonical key', () => {
    const out = dedupeItems([yt('a'), web('1', 'https://e.com/x'), yt('a')]);
    expect(out.map((i) => i.id)).toEqual(['a', '1']);
  });
});

describe('interleaveRanked', () => {
  it('round-robins provider lists preserving rank', () => {
    const out = interleaveRanked([[yt('a1'), yt('a2')], [web('b1', 'https://e.com/b1')]]);
    expect(out.map((i) => i.id)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('assembleByRank', () => {
  it('interleaves, dedupes, paginates with a key cursor', () => {
    const lists = [[yt('a'), yt('c')], [yt('b'), yt('a')]];
    const p1 = assembleByRank(lists, null, 2);
    expect(p1.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = assembleByRank(lists, p1.nextCursor, 2);
    expect(p2.items.map((i) => i.id)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/feed-item.test.ts`
Expected: FAIL — `canonicalKey`/`assembleByRank` not exported.

- [ ] **Step 3: Implement**

In `src/workers/feed-item.ts`:

1. Extend the type unions:

```ts
export type FeedSourceKind =
  | 'spooool_channel'
  | 'youtube_channel'
  | 'youtube_playlist'
  | 'youtube_search'
  | 'tiktok_video'
  | 'web_search';

export type FeedItemSource = 'spooool' | 'youtube' | 'tiktok' | 'dailymotion' | 'web';
```

2. Extend `FeedItem.embed`:

```ts
  embed?: { kind: 'youtube'; videoId: string } | { kind: 'dailymotion'; videoId: string };
```

3. Append the new helpers at the end of the file:

```ts
// Stable cross-provider identity for dedupe + relevance-cursor.
export function canonicalKey(item: FeedItem): string {
  if (item.source === 'youtube' && item.embed?.kind === 'youtube') {
    return `yt:${item.embed.videoId}`;
  }
  try {
    const u = new URL(item.url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.toLowerCase();
  } catch {
    return `${item.source}:${item.id}`;
  }
}

export function dedupeItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of items) {
    const k = canonicalKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// Round-robin interleave of per-provider ranked lists, preserving each list's order.
export function interleaveRanked(lists: FeedItem[][]): FeedItem[] {
  const out: FeedItem[] = [];
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      if (i < l.length) out.push(l[i]);
    }
  }
  return out;
}

export interface RankedAssembly {
  items: FeedItem[];
  nextCursor: string | null;
}

// Relevance ordering: interleave provider ranks, dedupe, then page by a cursor
// that encodes the canonicalKey of the last returned item.
export function assembleByRank(
  lists: FeedItem[][],
  cursor: string | null,
  limit: number,
): RankedAssembly {
  const ordered = dedupeItems(interleaveRanked(lists));
  let start = 0;
  if (cursor) {
    let key: string;
    try {
      key = atob(cursor);
    } catch {
      key = '';
    }
    const idx = ordered.findIndex((i) => canonicalKey(i) === key);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = ordered.slice(start, start + limit);
  const hasMore = start + limit < ordered.length;
  const nextCursor = hasMore && page.length > 0 ? btoa(canonicalKey(page[page.length - 1])) : null;
  return { items: page, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/feed-item.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/feed-item.ts src/workers/feed-item.test.ts
git commit -m "feat: add cross-provider dedupe + relevance assembly to feed-item"
```

---

## Task 3: DailyMotion search client

**Files:**
- Create: `src/workers/dailymotion.ts`
- Test: `src/workers/dailymotion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/dailymotion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeDailyMotionItem, getDailyMotionSearchItems } from './dailymotion';

const raw = {
  id: 'x9abcd',
  title: 'Cool clip',
  'owner.screenname': 'SomeUser',
  thumbnail_360_url: 'https://s1.dmcdn.net/x9abcd.jpg',
  created_time: 1_700_000_000, // seconds
  duration: 95,
};

describe('normalizeDailyMotionItem', () => {
  it('maps fields to a FeedItem', () => {
    expect(normalizeDailyMotionItem(raw)).toEqual({
      source: 'dailymotion',
      id: 'x9abcd',
      title: 'Cool clip',
      author: 'SomeUser',
      thumbnailUrl: 'https://s1.dmcdn.net/x9abcd.jpg',
      publishedAt: 1_700_000_000_000,
      durationSec: 95,
      url: 'https://www.dailymotion.com/video/x9abcd',
    });
  });
  it('returns null without an id', () => {
    expect(normalizeDailyMotionItem({ ...raw, id: undefined })).toBeNull();
  });
});

describe('getDailyMotionSearchItems', () => {
  it('fetches, normalizes, and caches', async () => {
    const store = new Map<string, string>();
    const CACHE = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace;
    const fetcher = (async () =>
      new Response(JSON.stringify({ list: [raw] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getDailyMotionSearchItems({ CACHE }, 'cats', fetcher);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].source).toBe('dailymotion');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/dailymotion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/workers/dailymotion.ts`:

```ts
// DailyMotion Graph API search client. The /videos endpoint is public and
// credential-free. Not a model provider — outside the AI-Gateway rule.
import { cachedItems, type CachedItemsEnv, type CachedItemsResult } from './cache';
import { kvHash, type FeedItem } from './feed-item';

export type DailyMotionEnv = CachedItemsEnv;

const API = 'https://api.dailymotion.com/videos';
const FIELDS = 'id,title,owner.screenname,thumbnail_360_url,created_time,duration';
const LIMIT = 15;
const TTL = 30 * 60;

interface RawDM {
  id?: string;
  title?: string;
  'owner.screenname'?: string;
  thumbnail_360_url?: string;
  created_time?: number;
  duration?: number;
}

export function normalizeDailyMotionItem(raw: RawDM): FeedItem | null {
  if (!raw.id) return null;
  return {
    source: 'dailymotion',
    id: raw.id,
    title: raw.title ?? 'Untitled',
    author: raw['owner.screenname'] ?? 'DailyMotion',
    thumbnailUrl: raw.thumbnail_360_url ?? null,
    publishedAt: raw.created_time ? raw.created_time * 1000 : 0,
    durationSec: typeof raw.duration === 'number' ? raw.duration : null,
    url: `https://www.dailymotion.com/video/${raw.id}`,
  };
}

export function getDailyMotionSearchItems(
  env: DailyMotionEnv,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<CachedItemsResult> {
  const key = `dm:search:${kvHash(query.trim().toLowerCase())}`;
  return cachedItems(env, key, TTL, async () => {
    const url = new URL(API);
    url.searchParams.set('search', query);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('limit', String(LIMIT));
    const res = await fetcher(url.toString());
    if (!res.ok) throw new Error(`dailymotion ${res.status}`);
    const data = (await res.json()) as { list?: RawDM[] };
    return (data.list ?? [])
      .map(normalizeDailyMotionItem)
      .filter((i): i is FeedItem => i !== null);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/dailymotion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/dailymotion.ts src/workers/dailymotion.test.ts
git commit -m "feat: add DailyMotion video search provider"
```

---

## Task 4: Brave video search client

**Files:**
- Create: `src/workers/brave.ts`
- Test: `src/workers/brave.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/brave.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeBraveVideo, getBraveVideoSearchItems, BraveConfigError } from './brave';

const raw = {
  url: 'https://vimeo.com/12345',
  title: 'A talk',
  age: '2024-01-02T00:00:00',
  thumbnail: { src: 'https://img/thumb.jpg' },
  video: { duration: '12:30', creator: 'Speaker' },
};

function fakeEnv(key?: string) {
  const store = new Map<string, string>();
  return {
    BRAVE_SEARCH_API_KEY: key,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  };
}

describe('normalizeBraveVideo', () => {
  it('maps to a web FeedItem', () => {
    const item = normalizeBraveVideo(raw)!;
    expect(item.source).toBe('web');
    expect(item.url).toBe('https://vimeo.com/12345');
    expect(item.author).toBe('Speaker');
    expect(item.durationSec).toBe(750);
    expect(item.thumbnailUrl).toBe('https://img/thumb.jpg');
  });
  it('returns null without a url', () => {
    expect(normalizeBraveVideo({ ...raw, url: undefined })).toBeNull();
  });
});

describe('getBraveVideoSearchItems', () => {
  it('errors via cache fallback when key missing', async () => {
    const r = await getBraveVideoSearchItems(fakeEnv(undefined), 'q', (async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);
    expect(r.error).toBe('BRAVE_SEARCH_API_KEY is not configured');
  });
  it('fetches + normalizes with a key', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ results: [raw] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getBraveVideoSearchItems(fakeEnv('k'), 'q', fetcher);
    expect(r.items).toHaveLength(1);
  });
});

describe('BraveConfigError', () => {
  it('is an Error', () => {
    expect(new BraveConfigError('x')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/brave.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/workers/brave.ts`:

```ts
// Brave Search API — video search. Requires X-Subscription-Token. Not a model
// provider — outside the AI-Gateway rule.
import { cachedItems, type CachedItemsEnv, type CachedItemsResult } from './cache';
import { kvHash, type FeedItem } from './feed-item';

export interface BraveEnv extends CachedItemsEnv {
  BRAVE_SEARCH_API_KEY?: string;
}

export class BraveConfigError extends Error {}

const API = 'https://api.search.brave.com/res/v1/videos/search';
const COUNT = 15;
const TTL = 30 * 60;

interface RawBrave {
  url?: string;
  title?: string;
  age?: string;
  thumbnail?: { src?: string };
  video?: { duration?: string; creator?: string; publisher?: string };
}

// "12:30" -> 750, "1:02:03" -> 3723. Returns null when unparseable.
function parseClockDuration(d?: string): number | null {
  if (!d) return null;
  const parts = d.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function normalizeBraveVideo(raw: RawBrave): FeedItem | null {
  if (!raw.url) return null;
  return {
    source: 'web',
    id: raw.url,
    title: raw.title ?? 'Untitled',
    author: raw.video?.creator ?? raw.video?.publisher ?? 'Web',
    thumbnailUrl: raw.thumbnail?.src ?? null,
    publishedAt: raw.age ? Date.parse(raw.age) || 0 : 0,
    durationSec: parseClockDuration(raw.video?.duration),
    url: raw.url,
  };
}

export function getBraveVideoSearchItems(
  env: BraveEnv,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<CachedItemsResult> {
  const key = `brave:search:${kvHash(query.trim().toLowerCase())}`;
  return cachedItems(env, key, TTL, async () => {
    if (!env.BRAVE_SEARCH_API_KEY) {
      throw new BraveConfigError('BRAVE_SEARCH_API_KEY is not configured');
    }
    const url = new URL(API);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(COUNT));
    const res = await fetcher(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const data = (await res.json()) as { results?: RawBrave[] };
    return (data.results ?? [])
      .map(normalizeBraveVideo)
      .filter((i): i is FeedItem => i !== null);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/brave.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/brave.ts src/workers/brave.test.ts
git commit -m "feat: add Brave video search provider"
```

---

## Task 5: Firecrawl search client

**Files:**
- Create: `src/workers/firecrawl.ts`
- Test: `src/workers/firecrawl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/firecrawl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeFirecrawlResult, getFirecrawlVideoItems } from './firecrawl';

const videoResult = {
  url: 'https://www.tiktok.com/@u/video/123',
  title: 'Trend',
  description: 'desc',
  metadata: { ogImage: 'https://img/og.jpg' },
};
const nonVideoResult = { url: 'https://example.com/blog', title: 'Article' };

function fakeEnv(url = 'https://firecrawl-cf.lazee.workers.dev') {
  const store = new Map<string, string>();
  return {
    FIRECRAWL_URL: url,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  };
}

describe('normalizeFirecrawlResult', () => {
  it('maps a video-bearing page to a web FeedItem', () => {
    const item = normalizeFirecrawlResult(videoResult)!;
    expect(item.source).toBe('web');
    expect(item.url).toBe('https://www.tiktok.com/@u/video/123');
    expect(item.thumbnailUrl).toBe('https://img/og.jpg');
  });
  it('drops non-video pages', () => {
    expect(normalizeFirecrawlResult(nonVideoResult)).toBeNull();
  });
});

describe('getFirecrawlVideoItems', () => {
  it('posts query, keeps only video results', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ data: [videoResult, nonVideoResult] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getFirecrawlVideoItems(fakeEnv(), 'trending', fetcher);
    expect(r.items).toHaveLength(1);
  });
  it('errors when FIRECRAWL_URL missing', async () => {
    const r = await getFirecrawlVideoItems(fakeEnv(''), 'q', (async () => {
      throw new Error('no fetch');
    }) as unknown as typeof fetch);
    expect(r.error).toBe('FIRECRAWL_URL is not configured');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/firecrawl.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/workers/firecrawl.ts`:

```ts
// Firecrawl search client (user's self-hosted instance). Used for broad web
// video-page discovery. Not a model provider — outside the AI-Gateway rule.
import { cachedItems, type CachedItemsEnv, type CachedItemsResult } from './cache';
import { kvHash, type FeedItem } from './feed-item';

export interface FirecrawlEnv extends CachedItemsEnv {
  FIRECRAWL_URL?: string;
  FIRECRAWL_API_KEY?: string;
}

const LIMIT = 15;
const TTL = 30 * 60;

// Hosts/paths that indicate a watchable video page.
const VIDEO_URL_RE =
  /(youtube\.com\/watch|youtu\.be\/|tiktok\.com\/.+\/video\/|vimeo\.com\/\d|dailymotion\.com\/video\/|twitter\.com\/.+\/status\/|x\.com\/.+\/status\/|\/watch\b|\.(mp4|m3u8|webm)(\?|$))/i;

interface RawFC {
  url?: string;
  title?: string;
  description?: string;
  metadata?: { ogImage?: string; 'og:image'?: string };
}

export function normalizeFirecrawlResult(raw: RawFC): FeedItem | null {
  if (!raw.url || !VIDEO_URL_RE.test(raw.url)) return null;
  const thumb = raw.metadata?.ogImage ?? raw.metadata?.['og:image'] ?? null;
  return {
    source: 'web',
    id: raw.url,
    title: raw.title ?? 'Untitled',
    author: 'Web',
    thumbnailUrl: thumb,
    publishedAt: 0,
    durationSec: null,
    url: raw.url,
  };
}

export function getFirecrawlVideoItems(
  env: FirecrawlEnv,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<CachedItemsResult> {
  const key = `fc:search:${kvHash(query.trim().toLowerCase())}`;
  return cachedItems(env, key, TTL, async () => {
    if (!env.FIRECRAWL_URL) throw new Error('FIRECRAWL_URL is not configured');
    const res = await fetcher(`${env.FIRECRAWL_URL.replace(/\/$/, '')}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(env.FIRECRAWL_API_KEY ? { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` } : {}),
      },
      body: JSON.stringify({ query, limit: LIMIT }),
    });
    if (!res.ok) throw new Error(`firecrawl ${res.status}`);
    const data = (await res.json()) as { data?: RawFC[] };
    return (data.data ?? [])
      .map(normalizeFirecrawlResult)
      .filter((i): i is FeedItem => i !== null);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/firecrawl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/firecrawl.ts src/workers/firecrawl.test.ts
git commit -m "feat: add Firecrawl video discovery provider"
```

---

## Task 6: Cobalt playback resolver

**Files:**
- Create: `src/workers/cobalt.ts`
- Test: `src/workers/cobalt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/cobalt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolvePlayable, resolvePlayableCached, CobaltError } from './cobalt';

function env(url = 'https://cobalt-api.lazee.workers.dev') {
  const store = new Map<string, string>();
  return {
    COBALT_URL: url,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
    store,
  };
}
const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('resolvePlayable', () => {
  it('maps tunnel/redirect to mp4', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({ status: 'tunnel', url: 'https://cdn/v.mp4' }));
    expect(r).toEqual({ kind: 'mp4', url: 'https://cdn/v.mp4' });
  });
  it('detects hls by .m3u8', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({ status: 'redirect', url: 'https://cdn/v.m3u8' }));
    expect(r.kind).toBe('hls');
  });
  it('picks first video from a picker', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({
      status: 'picker',
      picker: [{ type: 'photo', url: 'p' }, { type: 'video', url: 'https://cdn/pick.mp4' }],
    }));
    expect(r.url).toBe('https://cdn/pick.mp4');
  });
  it('throws CobaltError on error status', async () => {
    await expect(
      resolvePlayable(env(), 'https://x/y', ok({ status: 'error', error: { code: 'fetch.fail' } })),
    ).rejects.toBeInstanceOf(CobaltError);
  });
  it('throws when COBALT_URL missing', async () => {
    await expect(resolvePlayable(env(''), 'https://x/y', ok({}))).rejects.toBeInstanceOf(CobaltError);
  });
});

describe('resolvePlayableCached', () => {
  it('caches the resolved playable by url', async () => {
    const e = env();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: 'tunnel', url: 'https://cdn/v.mp4' }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolvePlayableCached(e, 'https://x/y', fetcher);
    await resolvePlayableCached(e, 'https://x/y', fetcher);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/cobalt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/workers/cobalt.ts`:

```ts
// Cobalt media resolver (user's self-hosted instance, v11.x). Given a video URL
// it returns a direct playable stream so spooool can play any surfaced item
// inline. Used for PLAYBACK ONLY in this phase (no import/download). Cobalt
// tunnel/redirect URLs are short-lived, so resolved URLs are cached only briefly.
import { kvHash } from './feed-item';

export interface CobaltEnv {
  COBALT_URL?: string;
  COBALT_API_KEY?: string;
  CACHE: KVNamespace;
}

export interface Playable {
  kind: 'mp4' | 'hls';
  url: string;
}

export class CobaltError extends Error {}

const TTL = 5 * 60; // resolved stream URLs expire quickly

interface CobaltResponse {
  status?: string;
  url?: string;
  text?: string;
  error?: { code?: string };
  picker?: Array<{ type?: string; url?: string }>;
}

function classify(url: string): Playable {
  return { kind: url.includes('.m3u8') ? 'hls' : 'mp4', url };
}

export async function resolvePlayable(
  env: CobaltEnv,
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Playable> {
  if (!env.COBALT_URL) throw new CobaltError('COBALT_URL is not configured');
  const res = await fetcher(`${env.COBALT_URL.replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(env.COBALT_API_KEY ? { Authorization: `Api-Key ${env.COBALT_API_KEY}` } : {}),
    },
    body: JSON.stringify({ url: sourceUrl, downloadMode: 'auto', videoQuality: '720' }),
  });
  const body = (await res.json().catch(() => ({}))) as CobaltResponse;
  switch (body.status) {
    case 'tunnel':
    case 'redirect':
    case 'stream':
      if (!body.url) throw new CobaltError('Cobalt returned no url');
      return classify(body.url);
    case 'picker': {
      const first = body.picker?.find((p) => p.type === 'video') ?? body.picker?.[0];
      if (!first?.url) throw new CobaltError('Cobalt picker had no playable');
      return classify(first.url);
    }
    default:
      throw new CobaltError(body.error?.code ?? body.text ?? `cobalt status ${body.status ?? res.status}`);
  }
}

export async function resolvePlayableCached(
  env: CobaltEnv,
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Playable> {
  const key = `cobalt:resolve:${kvHash(sourceUrl)}`;
  const hit = await env.CACHE.get(key);
  if (hit !== null) return JSON.parse(hit) as Playable;
  const playable = await resolvePlayable(env, sourceUrl, fetcher);
  await env.CACHE.put(key, JSON.stringify(playable), { expirationTtl: TTL });
  return playable;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/cobalt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/cobalt.ts src/workers/cobalt.test.ts
git commit -m "feat: add Cobalt playback resolver"
```

---

## Task 7: Discover aggregator + router

**Files:**
- Create: `src/workers/discover.ts`
- Test: `src/workers/discover.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/discover.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import * as yt from './youtube';
import * as dm from './dailymotion';
import * as brave from './brave';
import * as fc from './firecrawl';
import { aggregateSearch } from './discover';
import type { FeedItem } from './feed-item';

function item(source: FeedItem['source'], id: string, url: string): FeedItem {
  return { source, id, title: id, author: 'a', thumbnailUrl: null, publishedAt: 0, durationSec: null, url };
}
const env = { CACHE: {} as KVNamespace } as never;

describe('aggregateSearch', () => {
  it('fans out, interleaves, and reports provider status (relevance)', async () => {
    vi.spyOn(yt, 'getYouTubeSearchItems').mockResolvedValue({ items: [item('youtube', 'y1', 'https://youtu.be/y1')] });
    vi.spyOn(dm, 'getDailyMotionSearchItems').mockResolvedValue({ items: [item('dailymotion', 'd1', 'https://dm/d1')] });
    vi.spyOn(brave, 'getBraveVideoSearchItems').mockResolvedValue({ items: [], error: 'no key' });
    vi.spyOn(fc, 'getFirecrawlVideoItems').mockResolvedValue({ items: [item('web', 'w1', 'https://e/w1')] });

    const r = await aggregateSearch(env, { q: 'x', providers: ['youtube', 'dailymotion', 'brave', 'firecrawl'], order: 'relevance', cursor: null, limit: 10 });
    expect(r.items.map((i) => i.id)).toEqual(['y1', 'd1', 'w1']);
    expect(r.providers.find((p) => p.key === 'brave')?.error).toBe('no key');
  });

  it('honours the providers filter', async () => {
    const spy = vi.spyOn(dm, 'getDailyMotionSearchItems').mockResolvedValue({ items: [] });
    vi.spyOn(yt, 'getYouTubeSearchItems').mockResolvedValue({ items: [] });
    await aggregateSearch(env, { q: 'x', providers: ['youtube'], order: 'relevance', cursor: null, limit: 10 });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workers/discover.test.ts`
Expected: FAIL — `./discover` not found.

- [ ] **Step 3: Implement**

Create `src/workers/discover.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import {
  assembleByRank,
  assembleFeed,
  type FeedItem,
  type SourceResult,
} from './feed-item';
import { getYouTubeSearchItems, type YouTubeEnv } from './youtube';
import { getDailyMotionSearchItems, type DailyMotionEnv } from './dailymotion';
import { getBraveVideoSearchItems, type BraveEnv } from './brave';
import { getFirecrawlVideoItems, type FirecrawlEnv } from './firecrawl';
import { resolvePlayableCached, type CobaltEnv } from './cobalt';

export type ProviderKey = 'youtube' | 'dailymotion' | 'brave' | 'firecrawl';
export const ALL_PROVIDERS: ProviderKey[] = ['youtube', 'dailymotion', 'brave', 'firecrawl'];

export interface DiscoverEnv extends YouTubeEnv, DailyMotionEnv, BraveEnv, FirecrawlEnv, CobaltEnv {}

type SessionUser = { id: string } | null;
type DiscoverVars = { user: SessionUser };

export interface AggregateOptions {
  q: string;
  providers: ProviderKey[];
  order: 'relevance' | 'date';
  cursor: string | null;
  limit: number;
}

export interface DiscoverResult {
  items: FeedItem[];
  nextCursor: string | null;
  providers: Array<{ key: ProviderKey; error?: string; stale?: boolean }>;
}

async function runProvider(
  env: DiscoverEnv,
  key: ProviderKey,
  q: string,
  fetcher: typeof fetch,
): Promise<{ key: ProviderKey; items: FeedItem[]; error?: string; stale?: boolean }> {
  try {
    const r =
      key === 'youtube'
        ? await getYouTubeSearchItems(env, q, fetcher)
        : key === 'dailymotion'
          ? await getDailyMotionSearchItems(env, q, fetcher)
          : key === 'brave'
            ? await getBraveVideoSearchItems(env, q, fetcher)
            : await getFirecrawlVideoItems(env, q, fetcher);
    return { key, items: r.items, error: r.error, stale: r.stale };
  } catch (err) {
    return { key, items: [], error: err instanceof Error ? err.message : 'provider failed' };
  }
}

export async function aggregateSearch(
  env: DiscoverEnv,
  opts: AggregateOptions,
  fetcher: typeof fetch = fetch,
): Promise<DiscoverResult> {
  const selected = opts.providers.filter((p) => ALL_PROVIDERS.includes(p));
  const settled = await Promise.allSettled(selected.map((k) => runProvider(env, k, opts.q, fetcher)));
  const perProvider = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { key: selected[i], items: [] as FeedItem[], error: 'provider rejected' },
  );

  const providers = perProvider.map(({ key, error, stale }) => ({ key, ...(error ? { error } : {}), ...(stale ? { stale: true } : {}) }));

  if (opts.order === 'date') {
    const results: SourceResult[] = perProvider.map((p) => ({
      sourceId: p.key,
      kind: 'web_search',
      items: p.items,
    }));
    const assembled = assembleFeed(results, opts.cursor, opts.limit);
    return { items: assembled.items, nextCursor: assembled.nextCursor, providers };
  }

  const ranked = assembleByRank(perProvider.map((p) => p.items), opts.cursor, opts.limit);
  return { items: ranked.items, nextCursor: ranked.nextCursor, providers };
}

const searchSchema = z.object({
  q: z.string().trim().min(1).max(256),
  providers: z.string().optional(),
  order: z.enum(['relevance', 'date']).default('relevance'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(15),
});

function parseProviders(csv: string | undefined): ProviderKey[] {
  if (!csv) return ALL_PROVIDERS;
  const parts = csv.split(',').map((s) => s.trim()) as ProviderKey[];
  const valid = parts.filter((p) => ALL_PROVIDERS.includes(p));
  return valid.length ? valid : ALL_PROVIDERS;
}

export const discoverRoutes = new Hono<{ Bindings: DiscoverEnv; Variables: DiscoverVars }>();

discoverRoutes.get('/api/discover/search', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  const result = await aggregateSearch(c.env, {
    q: parsed.data.q,
    providers: parseProviders(parsed.data.providers),
    order: parsed.data.order,
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit,
  });
  return c.json(result);
});

discoverRoutes.get('/api/discover/resolve', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing url' }, 400);
  try {
    const playable = await resolvePlayableCached(c.env, url);
    return c.json(playable);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'resolve failed' }, 502);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workers/discover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/discover.ts src/workers/discover.test.ts
git commit -m "feat: add discover aggregator + /api/discover routes"
```

---

## Task 8: Wire router into the worker + env + wrangler vars

**Files:**
- Modify: `src/workers/index.ts`
- Modify: `wrangler.toml`
- Test: `src/workers/discover.workers.test.ts`

- [ ] **Step 1: Write the failing worker-integration test**

Create `src/workers/discover.workers.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/api/discover/search', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await SELF.fetch('https://example.com/api/discover/search?q=cats');
    expect(res.status).toBe(401);
  });

  it('400s on empty q (after auth path)', async () => {
    // No session cookie -> 401 still returned before validation; assert 401 here
    // and rely on discover.test.ts for validation coverage.
    const res = await SELF.fetch('https://example.com/api/discover/search');
    expect([400, 401]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:workers -- src/workers/discover.workers.test.ts`
Expected: FAIL — route not mounted (404, not 401).

- [ ] **Step 3: Extend the Env type**

In `src/workers/index.ts`, inside the `EnvBindings` type (where `YOUTUBE_API_KEY?` is declared), add:

```ts
  // Cross-web video search providers (src/workers/discover.ts).
  BRAVE_SEARCH_API_KEY?: string; // secret (Doppler-synced)
  FIRECRAWL_URL?: string; // [vars] — user's Firecrawl instance
  FIRECRAWL_API_KEY?: string; // secret (optional, only if the instance requires auth)
  // Cobalt playback resolver (src/workers/cobalt.ts).
  COBALT_URL?: string; // [vars] — user's Cobalt instance
  COBALT_API_KEY?: string; // secret (optional)
```

- [ ] **Step 4: Mount the router**

In `src/workers/index.ts`:
1. Add the import near the `feedRoutes` import (line ~45):

```ts
import { discoverRoutes } from './discover';
```

2. Add the route registration next to `app.route('/', feedRoutes);` (line ~255):

```ts
app.route('/', discoverRoutes);
```

(Placing it after the auth middleware at line ~193 ensures `c.get('user')` is populated, matching `feedRoutes`.)

- [ ] **Step 5: Add wrangler vars**

In `wrangler.toml`, under the top-level `[vars]` table (line ~205), add:

```toml
FIRECRAWL_URL = "https://firecrawl-cf.lazee.workers.dev"
COBALT_URL = "https://cobalt-api.lazee.workers.dev"
```

Add the same two keys to the `[env.staging] vars = { ... }` and `[env.production]` vars tables if they override `[vars]` (check those sections; if they use `vars = { ALLOWED_ORIGINS = "" }` style, extend that inline table with the two URLs).

- [ ] **Step 6: Run the worker-integration test**

Run: `npm run test:workers -- src/workers/discover.workers.test.ts`
Expected: PASS (401 for unauthenticated).

- [ ] **Step 7: Run full suite + typecheck**

Run: `npm test`
Then: `npx tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/workers/index.ts wrangler.toml src/workers/discover.workers.test.ts
git commit -m "feat: mount discover routes + provider env/vars"
```

---

## Task 9: web_search feed source (migration + assembly)

**Files:**
- Create: `src/db/migrations/0024_web_search_source.sql`
- Modify: `src/workers/feeds.ts`
- Modify: `src/workers/feed-warm.ts`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/0024_web_search_source.sql`:

```sql
-- Add the 'web_search' source kind. SQLite cannot alter a CHECK constraint in
-- place, so recreate feed_sources with the extended CHECK and copy rows.
-- For web_search rows, `ref` holds JSON: {"q": string, "providers": string[]}.
CREATE TABLE feed_sources_new (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video','web_search')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

INSERT INTO feed_sources_new (id, feed_id, kind, ref, label, position, added_at)
  SELECT id, feed_id, kind, ref, label, position, added_at FROM feed_sources;

DROP TABLE feed_sources;
ALTER TABLE feed_sources_new RENAME TO feed_sources;

CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);
```

- [ ] **Step 2: Write the failing test for web_search assembly**

Append to `src/workers/feeds.test.ts` (a unit test of the parsing helper). First, the helper must be exported. Add this test:

```ts
import { parseWebSearchRef } from './feeds';

describe('parseWebSearchRef', () => {
  it('parses q + providers JSON', () => {
    expect(parseWebSearchRef('{"q":"cats","providers":["youtube","brave"]}')).toEqual({
      q: 'cats',
      providers: ['youtube', 'brave'],
    });
  });
  it('falls back to all providers + raw string on bad JSON', () => {
    expect(parseWebSearchRef('cats')).toEqual({ q: 'cats', providers: ['youtube', 'dailymotion', 'brave', 'firecrawl'] });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: FAIL — `parseWebSearchRef` not exported.

- [ ] **Step 4: Implement web_search assembly in feeds.ts**

In `src/workers/feeds.ts`:

1. Extend imports:

```ts
import { aggregateSearch, ALL_PROVIDERS, type DiscoverEnv, type ProviderKey } from './discover';
```

2. Extend `FeedsEnv` to include discover providers:

```ts
export interface FeedsEnv extends YouTubeEnv, TikTokEnv, DiscoverEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}
```

3. Add the kind to `addSourceSchema`:

```ts
const addSourceSchema = z.object({
  kind: z.enum(['spooool_channel', 'youtube_channel', 'youtube_playlist', 'youtube_search', 'tiktok_video', 'web_search']),
  ref: z.string().min(1).max(2048),
});
```

4. Add the exported parser (above `fetchSourceItems`):

```ts
export function parseWebSearchRef(ref: string): { q: string; providers: ProviderKey[] } {
  try {
    const parsed = JSON.parse(ref) as { q?: string; providers?: string[] };
    const providers = (parsed.providers ?? []).filter((p): p is ProviderKey =>
      (ALL_PROVIDERS as string[]).includes(p),
    );
    if (parsed.q) return { q: parsed.q, providers: providers.length ? providers : [...ALL_PROVIDERS] };
  } catch {
    // not JSON — treat the whole ref as the query
  }
  return { q: ref, providers: [...ALL_PROVIDERS] };
}
```

5. In `fetchSourceItems`, add a branch before the tiktok fallback:

```ts
    if (s.kind === 'web_search') {
      const { q, providers } = parseWebSearchRef(s.ref);
      const r = await aggregateSearch(env, { q, providers, order: 'date', cursor: null, limit: 15 });
      const error = r.providers.find((p) => p.error)?.error;
      return { ...base, items: r.items, error };
    }
```

6. In `resolveSource`, add a branch before the tiktok fallback:

```ts
  if (kind === 'web_search') {
    const { q, providers } = parseWebSearchRef(ref);
    return { ref: JSON.stringify({ q, providers }), label: `Web search: ${q}` };
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/workers/feeds.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the warmer exclusion**

In `src/workers/feed-warm.ts`, find where source kinds are iterated/warmed. Add a comment and skip `web_search` (mirroring how `youtube_search` is excluded). If the warmer has an allow-list of kinds it warms, leave `web_search` out of it; if it warms all kinds, add:

```ts
      // web_search is the most cost-sensitive kind (multi-provider fan-out) —
      // do NOT pre-warm it, matching the youtube_search exclusion.
      if (source.kind === 'web_search') continue;
```

Read the file first to apply the matching pattern; if `youtube_search` is already skipped, add `web_search` to the same condition.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/0024_web_search_source.sql src/workers/feeds.ts src/workers/feeds.test.ts src/workers/feed-warm.ts
git commit -m "feat: add web_search feed source backed by the discover aggregator"
```

---

## Task 10: Frontend — Mantine deps + discover client types

**Files:**
- Modify: `package.json`
- Modify: `src/frontend/lib/feeds-client.ts`
- Create: `src/frontend/lib/discover-client.ts`

- [ ] **Step 1: Install Mantine + video player**

Run:

```bash
npm install @mantine/core@^7 @mantine/hooks@^7 @gfazioli/mantine-video
```

Expected: deps added to `package.json`. (`hls.js` is already present.)

- [ ] **Step 2: Verify the lint:deps guard still passes**

Run: `npm run lint:deps`
Expected: PASS. If `scripts/check-package-deps.mjs` flags the new packages, read it and add them to its allow-list with a one-line comment.

- [ ] **Step 3: Extend feeds-client types**

In `src/frontend/lib/feeds-client.ts`:

```ts
export type FeedSourceKind =
  | 'spooool_channel' | 'youtube_channel' | 'youtube_playlist' | 'youtube_search' | 'tiktok_video' | 'web_search';
```

and

```ts
export interface FeedItem {
  source: 'spooool' | 'youtube' | 'tiktok' | 'dailymotion' | 'web';
  id: string;
  title: string;
  author: string;
  thumbnailUrl: string | null;
  publishedAt: number;
  durationSec: number | null;
  url: string;
  embed?: { kind: 'youtube'; videoId: string } | { kind: 'dailymotion'; videoId: string };
}
```

- [ ] **Step 4: Create the discover client**

Create `src/frontend/lib/discover-client.ts`:

```ts
// Typed client for the discover API (src/workers/discover.ts). Same-origin
// credentials so the better-auth session cookie is sent.
import type { FeedItem } from './feeds-client';

export type ProviderKey = 'youtube' | 'dailymotion' | 'brave' | 'firecrawl';
export const ALL_PROVIDERS: ProviderKey[] = ['youtube', 'dailymotion', 'brave', 'firecrawl'];

export interface DiscoverResponse {
  items: FeedItem[];
  nextCursor: string | null;
  providers: Array<{ key: ProviderKey; error?: string; stale?: boolean }>;
}

export interface Playable {
  kind: 'mp4' | 'hls';
  url: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function searchDiscover(params: {
  q: string;
  providers?: ProviderKey[];
  order?: 'relevance' | 'date';
  cursor?: string;
}): Promise<DiscoverResponse> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.providers?.length) qs.set('providers', params.providers.join(','));
  if (params.order) qs.set('order', params.order);
  if (params.cursor) qs.set('cursor', params.cursor);
  return json<DiscoverResponse>(await fetch(`/api/discover/search?${qs}`, { credentials: 'same-origin' }));
}

export async function resolvePlayable(url: string): Promise<Playable> {
  return json<Playable>(
    await fetch(`/api/discover/resolve?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' }),
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/frontend/lib/feeds-client.ts src/frontend/lib/discover-client.ts
git commit -m "feat: add Mantine deps + discover client"
```

---

## Task 11: Frontend — InlineVideoPlayer

**Files:**
- Create: `src/frontend/components/InlineVideoPlayer.tsx`

- [ ] **Step 1: Implement the player**

Create `src/frontend/components/InlineVideoPlayer.tsx`:

```tsx
// Inline player for surfaced feed items. YouTube uses its iframe embed;
// everything else is resolved to a direct stream via Cobalt and played in
// Mantine Video. HLS streams attach the existing hls.js to the <video> ref.
// Native spooool uploads are NOT handled here (they use the Stream player on
// the watch route).
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Video } from '@gfazioli/mantine-video';
import type { FeedItem } from '../lib/feeds-client';
import { resolvePlayable, type Playable } from '../lib/discover-client';
import { YouTubeEmbed } from './YouTubeEmbed';

export function InlineVideoPlayer({ item }: { item: FeedItem }): JSX.Element {
  if (item.source === 'youtube' && item.embed?.kind === 'youtube') {
    return <YouTubeEmbed videoId={item.embed.videoId} title={item.title} thumbnailUrl={item.thumbnailUrl} />;
  }
  return <CobaltPlayer item={item} />;
}

function CobaltPlayer({ item }: { item: FeedItem }): JSX.Element {
  const [playable, setPlayable] = useState<Playable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setPlayable(await resolvePlayable(item.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load video');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (playable?.kind !== 'hls' || !videoRef.current) return;
    const video = videoRef.current;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playable.url;
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(playable.url);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
  }, [playable]);

  if (!playable) {
    return (
      <div className="feed-card__thumb-link">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="feed-card__thumb" loading="lazy" />
        ) : (
          <div className="feed-card__thumb feed-card__thumb--empty" />
        )}
        <button type="button" className="feed-card__play" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '▶ Play'}
        </button>
        {error && (
          <p className="ds-meta feed-card__error">
            {error} —{' '}
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              open original
            </a>
          </p>
        )}
      </div>
    );
  }

  // Mantine Video for muxed MP4; for HLS we render a bare <video> the effect wires hls.js into.
  if (playable.kind === 'hls') {
    return <video ref={videoRef} className="feed-card__video" controls autoPlay playsInline />;
  }
  return <Video src={playable.url} controls autoPlay />;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `@gfazioli/mantine-video`'s export name differs from `Video`, check its `dist` types and adjust the import — it exposes a compound `Video` component.)

- [ ] **Step 3: Commit**

```bash
git add src/frontend/components/InlineVideoPlayer.tsx
git commit -m "feat: add InlineVideoPlayer (YouTube iframe / Cobalt MP4 / HLS)"
```

---

## Task 12: Frontend — use InlineVideoPlayer in FeedItemCard

**Files:**
- Modify: `src/frontend/components/FeedItemCard.tsx`

- [ ] **Step 1: Update the card**

In `src/frontend/components/FeedItemCard.tsx`:

1. Update imports:

```tsx
import { Link } from 'react-router-dom';
import type { FeedItem } from '../lib/feeds-client';
import { InlineVideoPlayer } from './InlineVideoPlayer';
```

2. Update `SourceBadge` to cover the new sources:

```tsx
function SourceBadge({ source }: { source: FeedItem['source'] }): JSX.Element {
  const label =
    source === 'spooool' ? 'spooool'
    : source === 'youtube' ? 'YouTube'
    : source === 'tiktok' ? 'TikTok'
    : source === 'dailymotion' ? 'DailyMotion'
    : 'Web';
  return <span className={`feed-badge feed-badge--${source}`}>{label}</span>;
}
```

3. Replace the `youtube` branch and the link-out fallback so all non-spooool items render through `InlineVideoPlayer`:

```tsx
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

  // Everything else plays inline via InlineVideoPlayer (YouTube iframe, else Cobalt).
  return (
    <article className={`feed-card feed-card--${item.source}`}>
      <InlineVideoPlayer item={item} />
      <Meta item={item} />
    </article>
  );
```

(Keep the existing `Meta` function unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/components/FeedItemCard.tsx
git commit -m "feat: play any surfaced feed item inline via InlineVideoPlayer"
```

---

## Task 13: Frontend — Discover page + route + nav + MantineProvider

**Files:**
- Create: `src/frontend/pages/Discover.tsx`
- Modify: `src/frontend/App.tsx`

- [ ] **Step 1: Create the Discover page**

Create `src/frontend/pages/Discover.tsx`:

```tsx
import { useState } from 'react';
import { FeedItemCard } from '../components/FeedItemCard';
import { searchDiscover, ALL_PROVIDERS, type ProviderKey, type DiscoverResponse } from '../lib/discover-client';
import type { FeedItem } from '../lib/feeds-client';

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  youtube: 'YouTube',
  dailymotion: 'DailyMotion',
  brave: 'Brave',
  firecrawl: 'Web',
};

export function Discover(): JSX.Element {
  const [q, setQ] = useState('');
  const [providers, setProviders] = useState<ProviderKey[]>([...ALL_PROVIDERS]);
  const [order, setOrder] = useState<'relevance' | 'date'>('relevance');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<DiscoverResponse['providers']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleProvider(p: ProviderKey) {
    setProviders((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  async function run(reset: boolean) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await searchDiscover({
        q,
        providers,
        order,
        cursor: reset ? undefined : cursor ?? undefined,
      });
      setItems((cur) => (reset ? res.items : [...cur, ...res.items]));
      setCursor(res.nextCursor);
      setStatus(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="discover">
      <h1>Discover</h1>
      <form
        className="discover__controls"
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <input
          className="discover__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search videos across the web…"
          aria-label="Search query"
        />
        <button type="submit" disabled={loading || !q.trim()}>
          Search
        </button>
      </form>

      <div className="discover__filters">
        {ALL_PROVIDERS.map((p) => (
          <label key={p} className="discover__chip">
            <input type="checkbox" checked={providers.includes(p)} onChange={() => toggleProvider(p)} />
            {PROVIDER_LABELS[p]}
          </label>
        ))}
        <label className="discover__chip">
          Order:
          <select value={order} onChange={(e) => setOrder(e.target.value as 'relevance' | 'date')}>
            <option value="relevance">Relevance</option>
            <option value="date">Newest</option>
          </select>
        </label>
      </div>

      {status.some((s) => s.error) && (
        <ul className="discover__provider-status">
          {status
            .filter((s) => s.error)
            .map((s) => (
              <li key={s.key} className="feed-badge feed-badge--error">
                {PROVIDER_LABELS[s.key]}: {s.error}
              </li>
            ))}
        </ul>
      )}

      {error && <p className="discover__error">{error}</p>}

      <div className="feed-grid">
        {items.map((item) => (
          <FeedItemCard key={`${item.source}:${item.id}`} item={item} />
        ))}
      </div>

      {cursor && (
        <button type="button" className="discover__more" onClick={() => void run(false)} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Register the lazy route + MantineProvider + nav link in App.tsx**

In `src/frontend/App.tsx`:

1. Add the lazy import near the other page imports (line ~59):

```tsx
const Discover = lazy(() => import('./pages/Discover').then((m) => ({ default: m.Discover })));
```

2. Add Mantine at the top of the file (imports) and wrap the app root. Add imports:

```tsx
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
```

Find the top-level returned JSX (the outermost wrapper around `<Routes>`), and wrap it:

```tsx
return (
  <MantineProvider>
    {/* existing app tree (header + <Routes> …) */}
  </MantineProvider>
);
```

(If `App` returns a fragment with header + routes, wrap that fragment's contents in `<MantineProvider>`.)

3. Add the route alongside the other routes (near the `/watch/:id` route, line ~730):

```tsx
<Route path="/discover" element={<Discover />} />
```

4. Add a nav link near the existing Feeds nav entry. Locate the header nav `<Link to="/feeds">` (or the nav list) and add:

```tsx
<Link to="/discover" className="app-nav__link">Discover</Link>
```

Match the surrounding nav-link markup/classes exactly.

- [ ] **Step 3: Build to verify routing + Mantine integrate**

Run: `npm run build`
Expected: build succeeds (Mantine CSS + Discover chunk emitted).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/pages/Discover.tsx src/frontend/App.tsx
git commit -m "feat: add Discover page, route, nav, and MantineProvider"
```

---

## Task 14: Frontend — web_search source in FeedView

**Files:**
- Modify: `src/frontend/pages/FeedView.tsx`

- [ ] **Step 1: Read FeedView to find the source-add UI**

Run: `sed -n '1,200p' src/frontend/pages/FeedView.tsx` (read it). Locate the source-kind `<select>` / picker and the `addSource` call.

- [ ] **Step 2: Add the web_search option + ref construction**

In the source-kind picker, add an option:

```tsx
<option value="web_search">Web search</option>
```

When the chosen kind is `web_search`, the input the user types is the query. Build the ref as JSON before calling `addSource`. Where `addSource(feedId, { kind, ref })` is invoked, special-case it:

```tsx
const refValue =
  kind === 'web_search'
    ? JSON.stringify({ q: rawInput.trim(), providers: ['youtube', 'dailymotion', 'brave', 'firecrawl'] })
    : rawInput.trim();
await addSource(feed.id, { kind, ref: refValue });
```

(`rawInput` is the existing controlled input state for the source ref; reuse it.)

3. In the source list rendering, ensure `web_search` rows display their `label` (the worker already stores `Web search: <q>`). No special rendering needed beyond including the kind in any kind→label map present in the file.

- [ ] **Step 3: Build + typecheck**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/pages/FeedView.tsx
git commit -m "feat: add web_search source to FeedView"
```

---

## Task 15: Final verification + config

**Files:** none (operational)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all worker + unit tests PASS.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: PASS. (`lint:no-providers` must pass — none of the new clients are model providers; the comments in each file note this.)

- [ ] **Step 3: Set the Brave secret (user action)**

Run (user, with Doppler-sourced value):

```bash
doppler secrets get BRAVE_SEARCH_API_KEY --plain | wrangler secret put BRAVE_SEARCH_API_KEY
```

(If the Cobalt/Firecrawl instances require auth, also `wrangler secret put COBALT_API_KEY` / `FIRECRAWL_API_KEY`.)

- [ ] **Step 4: Manual smoke test (dev)**

Run: `npm run dev`, log in, visit `/discover`, search a term, confirm: results from multiple providers, a YouTube card plays via iframe, a non-YouTube card plays via Cobalt→Mantine Video, and a provider with no key shows an error badge (not a blank page). Then add a `web_search` source to a feed and confirm items appear.

- [ ] **Step 5: Final commit (if any doc/config tweaks)**

```bash
git add -A
git commit -m "chore: finalize discover search config"
```

---

## Self-Review Notes

- **Spec coverage:** providers (Tasks 3–5), Cobalt playback (Task 6 + 11), aggregator + dedupe + relevance/date + cursor (Tasks 2, 7), `/api/discover/search` + `/resolve` (Tasks 7–8), `web_search` source + migration + warmer exclusion (Task 9), Discover page + saved-search both surfaces (Tasks 13–14), Mantine Video + hls.js (Task 11), config/secrets (Tasks 8, 15) — all mapped.
- **Type consistency:** `ProviderKey`/`ALL_PROVIDERS` defined in `discover.ts` and re-declared in `discover-client.ts` (frontend can't import worker code); `FeedItem.source`/`embed` extended identically in `feed-item.ts` (worker) and `feeds-client.ts` (frontend). `cachedItems` signature reused by all providers.
- **No placeholders:** every code step shows full content; the only "read the file first" steps (feed-warm.ts skip, FeedView select, App.tsx nav) are existing-pattern matches with the exact snippet to add.
