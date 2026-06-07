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
