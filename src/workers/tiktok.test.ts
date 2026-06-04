import { describe, expect, it } from 'vitest';
import { isTikTokVideoUrl, getTikTokItem, type TikTokEnv } from './tiktok';

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isTikTokVideoUrl', () => {
  it('accepts canonical and short TikTok URLs', () => {
    expect(isTikTokVideoUrl('https://www.tiktok.com/@user/video/7300000000000000000')).toBe(true);
    expect(isTikTokVideoUrl('https://vm.tiktok.com/ZMabc123/')).toBe(true);
  });
  it('rejects non-TikTok or junk URLs', () => {
    expect(isTikTokVideoUrl('https://youtube.com/watch?v=x')).toBe(false);
    expect(isTikTokVideoUrl('not a url')).toBe(false);
  });
});

describe('getTikTokItem', () => {
  it('fetches + normalizes oEmbed and caches it', async () => {
    let calls = 0;
    const url = 'https://www.tiktok.com/@user/video/7300000000000000000';
    const fetcher = (async () => {
      calls++;
      return jsonResponse({
        title: 'Funny clip',
        author_name: 'user',
        thumbnail_url: 'https://p16.tiktokcdn.com/x.jpg',
      });
    }) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const first = await getTikTokItem(env, url, 1700000000000, fetcher);
    expect(first.item).toMatchObject({
      source: 'tiktok',
      id: '7300000000000000000',
      title: 'Funny clip',
      author: 'user',
      url,
    });
    expect(first.item?.embed).toBeUndefined();
    await getTikTokItem(env, url, 1700000000000, fetcher);
    expect(calls).toBe(1); // second call served from cache
  });

  it('returns an error for an invalid URL without calling the network', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const out = await getTikTokItem(env, 'https://example.com/x', 0, fetcher);
    expect(out.item).toBeNull();
    expect(out.error).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('returns an error result when oEmbed 404s', async () => {
    const fetcher = (async () => jsonResponse({}, 404)) as typeof fetch;
    const env: TikTokEnv = { CACHE: fakeKV() };
    const out = await getTikTokItem(env, 'https://www.tiktok.com/@u/video/7300000000000000001', 0, fetcher);
    expect(out.item).toBeNull();
    expect(out.error).toBeTruthy();
  });
});
