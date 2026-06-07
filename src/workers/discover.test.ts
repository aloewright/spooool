import { describe, expect, it, vi } from 'vitest';
import * as yt from './youtube';
import * as dm from './dailymotion';
import * as brave from './brave';
import * as fc from './firecrawl';
import { aggregateSearch } from './discover';
import type { FeedItem } from './feed-item';

function item(source: FeedItem['source'], id: string, url: string): FeedItem {
  return { source, id, title: id, author: 'a', thumbnailUrl: null, publishedAt: 0, durationSec: null, url };
}
const env = { CACHE: {} as KVNamespace } as never;

describe('aggregateSearch', () => {
  it('fans out, interleaves, and reports provider status (relevance)', async () => {
    vi.spyOn(yt, 'getYouTubeSearchItems').mockResolvedValue({ items: [item('youtube', 'y1', 'https://youtu.be/y1')] });
    vi.spyOn(dm, 'getDailyMotionSearchItems').mockResolvedValue({ items: [item('dailymotion', 'd1', 'https://dm/d1')] });
    vi.spyOn(brave, 'getBraveVideoSearchItems').mockResolvedValue({ items: [], error: 'no key' });
    vi.spyOn(fc, 'getFirecrawlVideoItems').mockResolvedValue({ items: [item('web', 'w1', 'https://e/w1')] });

    const r = await aggregateSearch(env, { q: 'x', providers: ['youtube', 'dailymotion', 'brave', 'firecrawl'], order: 'relevance', cursor: null, limit: 10 });
    expect(r.items.map((i) => i.id)).toEqual(['y1', 'd1', 'w1']);
    expect(r.providers.find((p) => p.key === 'brave')?.error).toBe('no key');
  });

  it('honours the providers filter', async () => {
    const spy = vi.spyOn(dm, 'getDailyMotionSearchItems').mockResolvedValue({ items: [] });
    vi.spyOn(yt, 'getYouTubeSearchItems').mockResolvedValue({ items: [] });
    await aggregateSearch(env, { q: 'x', providers: ['youtube'], order: 'relevance', cursor: null, limit: 10 });
    expect(spy).not.toHaveBeenCalled();
  });
});
