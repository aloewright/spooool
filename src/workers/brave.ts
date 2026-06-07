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
  const raw = d.split(':');
  if (raw.some((s) => s.trim() === '')) return null;
  const parts = raw.map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function normalizeBraveVideo(raw: RawBrave): FeedItem | null {
  if (!raw.url) return null;
  return {
    source: 'web',
    id: kvHash(raw.url),
    title: raw.title ?? 'Untitled',
    author: raw.video?.creator ?? raw.video?.publisher ?? 'Web',
    thumbnailUrl: raw.thumbnail?.src ?? null,
    publishedAt: raw.age ? Date.parse(raw.age) || 0 : 0,
    durationSec: parseClockDuration(raw.video?.duration),
    url: raw.url,
  };
}

export async function getBraveVideoSearchItems(
  env: BraveEnv,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<CachedItemsResult> {
  if (!env.BRAVE_SEARCH_API_KEY) {
    return { items: [], error: 'BRAVE_SEARCH_API_KEY is not configured' };
  }
  const key = `brave:search:${kvHash(query.trim().toLowerCase())}`;
  return cachedItems(env, key, TTL, async () => {
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
