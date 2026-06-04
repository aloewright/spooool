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
