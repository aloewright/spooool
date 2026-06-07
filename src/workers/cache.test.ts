import { describe, expect, it } from 'vitest';
import { cachedItems } from './cache';
import type { FeedItem } from './feed-item';

function fakeKV(store = new Map<string, string>()) {
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const item: FeedItem = {
  source: 'web' as FeedItem['source'], id: '1', title: 't', author: 'a',
  thumbnailUrl: null, publishedAt: 0, durationSec: null, url: 'https://e.com/1',
};

describe('cachedItems', () => {
  it('produces, caches fresh + last-good on miss', async () => {
    const CACHE = fakeKV();
    const r = await cachedItems({ CACHE }, 'k', 60, async () => [item]);
    expect(r.items).toEqual([item]);
    expect(CACHE.store.get('k')).toBe(JSON.stringify([item]));
    expect(CACHE.store.get('k:lg')).toBe(JSON.stringify([item]));
  });

  it('returns fresh cache without calling produce', async () => {
    const CACHE = fakeKV(new Map([['k', JSON.stringify([item])]]));
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('should not run');
    });
    expect(r.items).toEqual([item]);
  });

  it('falls back to last-good (stale) when produce throws', async () => {
    const CACHE = fakeKV(new Map([['k:lg', JSON.stringify([item])]]));
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('upstream down');
    });
    expect(r).toEqual({ items: [item], stale: true });
  });

  it('returns an error result when produce throws and no last-good', async () => {
    const CACHE = fakeKV();
    const r = await cachedItems({ CACHE }, 'k', 60, async () => {
      throw new Error('boom');
    });
    expect(r.items).toEqual([]);
    expect(r.error).toBe('boom');
  });
});
