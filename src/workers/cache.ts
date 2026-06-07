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
