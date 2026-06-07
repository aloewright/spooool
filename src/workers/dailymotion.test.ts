import { describe, expect, it } from 'vitest';
import { normalizeDailyMotionItem, getDailyMotionSearchItems } from './dailymotion';

const raw = {
  id: 'x9abcd',
  title: 'Cool clip',
  'owner.screenname': 'SomeUser',
  thumbnail_360_url: 'https://s1.dmcdn.net/x9abcd.jpg',
  created_time: 1_700_000_000,
  duration: 95,
};

describe('normalizeDailyMotionItem', () => {
  it('maps fields to a FeedItem', () => {
    expect(normalizeDailyMotionItem(raw)).toEqual({
      source: 'dailymotion',
      id: 'x9abcd',
      title: 'Cool clip',
      author: 'SomeUser',
      thumbnailUrl: 'https://s1.dmcdn.net/x9abcd.jpg',
      publishedAt: 1_700_000_000_000,
      durationSec: 95,
      url: 'https://www.dailymotion.com/video/x9abcd',
      embed: { kind: 'dailymotion', videoId: 'x9abcd' },
    });
  });
  it('returns null without an id', () => {
    expect(normalizeDailyMotionItem({ ...raw, id: undefined })).toBeNull();
  });
});

describe('getDailyMotionSearchItems', () => {
  it('fetches, normalizes, and caches', async () => {
    const store = new Map<string, string>();
    const CACHE = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace;
    const fetcher = (async () =>
      new Response(JSON.stringify({ list: [raw] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getDailyMotionSearchItems({ CACHE }, 'cats', fetcher);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].source).toBe('dailymotion');
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
      return new Response(JSON.stringify({ list: [raw] }), { status: 200 });
    }) as unknown as typeof fetch;
    await getDailyMotionSearchItems({ CACHE }, 'q', fetcher);
    await getDailyMotionSearchItems({ CACHE }, 'q', fetcher);
    expect(calls).toBe(1);
  });
});
