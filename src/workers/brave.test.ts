import { describe, expect, it } from 'vitest';
import { normalizeBraveVideo, getBraveVideoSearchItems, BraveConfigError } from './brave';

const raw = {
  url: 'https://vimeo.com/12345',
  title: 'A talk',
  age: '2024-01-02T00:00:00',
  thumbnail: { src: 'https://img/thumb.jpg' },
  video: { duration: '12:30', creator: 'Speaker' },
};

function fakeEnv(key?: string) {
  const store = new Map<string, string>();
  return {
    BRAVE_SEARCH_API_KEY: key,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  };
}

describe('normalizeBraveVideo', () => {
  it('maps to a web FeedItem', () => {
    const item = normalizeBraveVideo(raw)!;
    expect(item.source).toBe('web');
    expect(item.url).toBe('https://vimeo.com/12345');
    expect(item.author).toBe('Speaker');
    expect(item.durationSec).toBe(750);
    expect(item.thumbnailUrl).toBe('https://img/thumb.jpg');
  });
  it('returns null without a url', () => {
    expect(normalizeBraveVideo({ ...raw, url: undefined })).toBeNull();
  });
});

describe('getBraveVideoSearchItems', () => {
  it('errors via cache fallback when key missing', async () => {
    const r = await getBraveVideoSearchItems(fakeEnv(undefined), 'q', (async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch);
    expect(r.error).toBe('BRAVE_SEARCH_API_KEY is not configured');
  });
  it('fetches + normalizes with a key', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ results: [raw] }), { status: 200 })) as unknown as typeof fetch;
    const r = await getBraveVideoSearchItems(fakeEnv('k'), 'q', fetcher);
    expect(r.items).toHaveLength(1);
  });
});

describe('BraveConfigError', () => {
  it('is an Error', () => {
    expect(new BraveConfigError('x')).toBeInstanceOf(Error);
  });
});

describe('getBraveVideoSearchItems cache', () => {
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
      return new Response(JSON.stringify({ results: [raw] }), { status: 200 });
    }) as unknown as typeof fetch;
    await getBraveVideoSearchItems({ BRAVE_SEARCH_API_KEY: 'k', CACHE }, 'q', fetcher);
    await getBraveVideoSearchItems({ BRAVE_SEARCH_API_KEY: 'k', CACHE }, 'q', fetcher);
    expect(calls).toBe(1);
  });
});
