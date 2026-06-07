// Typed fetch wrappers for the custom-feeds API. Mirrors the shapes returned
// by src/workers/feeds.ts. All calls use same-origin credentials so the
// better-auth session cookie is sent.

export type FeedSourceKind =
  | 'spooool_channel' | 'youtube_channel' | 'youtube_playlist' | 'youtube_search' | 'tiktok_video' | 'web_search';

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
