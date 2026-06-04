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
