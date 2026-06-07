import { describe, expect, it } from 'vitest';
import { normalizeFirecrawlResult, getFirecrawlVideoItems } from './firecrawl';

const videoResult = {
  url: 'https://www.tiktok.com/@u/video/123',
  title: 'Trend',
  description: 'desc',
  metadata: { ogImage: 'https://img/og.jpg' },
};
const nonVideoResult = { url: 'https://example.com/blog', title: 'Article' };

function fakeEnv(url = 'https://firecrawl-cf.lazee.workers.dev') {
  const store = new Map<string, string>();
  return {
    FIRECRAWL_URL: url,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  };
}

describe('normalizeFirecrawlResult', () => {
  it('maps a video-bearing page to a web FeedItem', () => {
    const item = normalizeFirecrawlResult(videoResult)!;
    expect(item.source).toBe('web');
    expect(item.url).toBe('https://www.tiktok.com/@u/video/123');
    expect(item.thumbnailUrl).toBe('https://img/og.jpg');
  });
  it('drops non-video pages', () => {
    expect(normalizeFirecrawlResult(nonVideoResult)).toBeNull();
  });
});

describe('getFirecrawlVideoItems', () => {
  it('posts query, keeps only video results', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ data: [videoResult, nonVideoResult] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getFirecrawlVideoItems(fakeEnv(), 'trending', fetcher);
    expect(r.items).toHaveLength(1);
  });
  it('errors when FIRECRAWL_URL missing', async () => {
    const r = await getFirecrawlVideoItems(fakeEnv(''), 'q', (async () => {
      throw new Error('no fetch');
    }) as unknown as typeof fetch);
    expect(r.error).toBe('FIRECRAWL_URL is not configured');
  });

  it('serves the second call from cache', async () => {
    const store = new Map<string, string>();
    const CACHE = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async () => {},
    } as unknown as KVNamespace;
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [videoResult] }), { status: 200 });
    }) as unknown as typeof fetch;
    await getFirecrawlVideoItems({ FIRECRAWL_URL: 'https://fc', CACHE }, 'q', fetcher);
    await getFirecrawlVideoItems({ FIRECRAWL_URL: 'https://fc', CACHE }, 'q', fetcher);
    expect(calls).toBe(1);
  });
});
