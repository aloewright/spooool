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
