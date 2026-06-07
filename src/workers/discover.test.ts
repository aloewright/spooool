import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yt from './youtube';
import * as dm from './dailymotion';
import * as brave from './brave';
import * as fc from './firecrawl';
import { aggregateSearch, isResolvableUrl } from './discover';
import type { FeedItem } from './feed-item';

function item(source: FeedItem['source'], id: string, url: string): FeedItem {
  return { source, id, title: id, author: 'a', thumbnailUrl: null, publishedAt: 0, durationSec: null, url };
}
const env = { CACHE: {} as KVNamespace } as never;

describe('aggregateSearch', () => {
  afterEach(() => { vi.restoreAllMocks(); });
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

describe('isResolvableUrl', () => {
  it('allows public video hosts', () => {
    expect(isResolvableUrl('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isResolvableUrl('https://vimeo.com/123')).toBe(true);
  });

  it('blocks localhost and loopback', () => {
    expect(isResolvableUrl('http://localhost/x')).toBe(false);
    expect(isResolvableUrl('https://127.0.0.1/')).toBe(false);
  });

  it('blocks cloud metadata endpoint (link-local)', () => {
    expect(isResolvableUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('blocks private IP ranges', () => {
    expect(isResolvableUrl('https://10.0.0.5/')).toBe(false);
    expect(isResolvableUrl('https://192.168.1.1/')).toBe(false);
    expect(isResolvableUrl('https://172.16.0.1/')).toBe(false);
  });

  it('blocks .internal and .local hostnames', () => {
    expect(isResolvableUrl('https://foo.internal/')).toBe(false);
    expect(isResolvableUrl('https://myservice.local/')).toBe(false);
  });

  it('returns false for non-URL string', () => {
    expect(isResolvableUrl('not a url')).toBe(false);
  });

  it('returns false for non-http protocols', () => {
    expect(isResolvableUrl('file:///etc/passwd')).toBe(false);
  });
});
