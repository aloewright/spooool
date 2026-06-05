import { describe, expect, it, vi } from 'vitest';
import { warmFeedCaches, type FeedWarmEnv } from './feed-warm';

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

function fakeDB(rows: Array<{ kind: string; ref: string }>): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
    }),
  } as unknown as D1Database;
}

describe('warmFeedCaches', () => {
  it('refreshes only cheap channel/playlist sources for recently-viewed feeds', async () => {
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      seen.push(u);
      if (u.includes('/channels')) {
        return new Response(JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;

    const env: FeedWarmEnv = {
      DB: fakeDB([
        { kind: 'youtube_channel', ref: 'UC1' },
        { kind: 'youtube_playlist', ref: 'PL1' },
      ]),
      CACHE: fakeKV(),
      YOUTUBE_API_KEY: 'k',
    };
    const count = await warmFeedCaches(env, fetcher);
    expect(count).toBe(2);
    expect(seen.some((u) => u.includes('/playlistItems'))).toBe(true);
  });

  it('is a no-op when YOUTUBE_API_KEY is missing', async () => {
    const env: FeedWarmEnv = { DB: fakeDB([{ kind: 'youtube_channel', ref: 'UC1' }]), CACHE: fakeKV() };
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await warmFeedCaches(env, fetcher)).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
