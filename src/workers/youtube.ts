// YouTube Data API v3 client + pure parsing/normalization helpers.
// NOTE: youtube.com Data API is NOT an LLM/model provider — it is not covered
// by the AI-Gateway rule or scripts/check-no-direct-providers.mjs. Calls go
// direct (server-side) with env.YOUTUBE_API_KEY.

import { kvHash, type FeedItem } from './feed-item';

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
  return `yt:search:${kvHash(query.trim().toLowerCase())}`;
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
