// Normalized cross-service feed item + pure assembly (merge/sort/paginate).
// Kept dependency-free so it unit-tests in the node environment.

export type FeedSourceKind =
  | 'spooool_channel'
  | 'youtube_channel'
  | 'youtube_playlist'
  | 'youtube_search'
  | 'tiktok_video'
  | 'web_search';

export type FeedItemSource = 'spooool' | 'youtube' | 'tiktok' | 'dailymotion' | 'web';

export interface FeedItem {
  source: FeedItemSource;
  id: string; // platform-native id (spooool video id / YT video id / tiktok video id)
  title: string;
  author: string;
  thumbnailUrl: string | null;
  publishedAt: number; // epoch ms; sort key
  durationSec: number | null;
  url: string; // canonical watch/link-out URL
  embed?: { kind: 'youtube'; videoId: string } | { kind: 'dailymotion'; videoId: string }; // present only for inline-embeddable items
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

// Stable, fixed-length token for building KV cache keys from arbitrary user
// input (search queries, URLs). FNV-1a 32-bit → base36. Synchronous (no
// crypto.subtle/async ripple through the cache layer) and collision-resistant
// enough for a cache-key namespace, so two distinct inputs never share a key
// even when their prefixes match.
export function kvHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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

// Stable cross-provider identity for dedupe + relevance-cursor.
// Best-effort: does not normalize platform short-URLs (e.g. dai.ly) — those may not dedupe against canonical URLs.
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
    // Cursor key gone (results churned since last page) -> stop, don't restart at page 1.
    start = idx >= 0 ? idx + 1 : ordered.length;
  }
  const page = ordered.slice(start, start + limit);
  const hasMore = start + limit < ordered.length;
  const nextCursor = hasMore && page.length > 0 ? btoa(canonicalKey(page[page.length - 1])) : null;
  return { items: page, nextCursor };
}
