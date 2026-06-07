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
