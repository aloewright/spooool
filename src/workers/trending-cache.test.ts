import { describe, expect, it } from 'vitest';
import {
  TRENDING_CACHE_TTL_SECONDS,
  bumpTrendingCacheVersion,
  getTrendingCacheVersion,
  trendingCacheKey,
} from './trending-cache';

function makeFakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeRateLimitedKV(): KVNamespace {
  return {
    get: async () => null,
    put: async () => {
      throw new Error('429: KV rate limit');
    },
    delete: async () => {},
  } as unknown as KVNamespace;
}

describe('trendingCacheKey', () => {
  it('encodes both version and limit', () => {
    expect(trendingCacheKey('abc123', 12)).toBe('trending:vabc123:limit=12');
  });

  it('produces distinct keys for different versions', () => {
    expect(trendingCacheKey('a', 12)).not.toBe(trendingCacheKey('b', 12));
  });
});

describe('getTrendingCacheVersion', () => {
  it("returns '1' when the version key has never been written", async () => {
    const cache = makeFakeKV();
    expect(await getTrendingCacheVersion(cache)).toBe('1');
  });

  it('returns the stored value as-is', async () => {
    const cache = makeFakeKV({ 'trending:version': '1700000000000-deadbeef' });
    expect(await getTrendingCacheVersion(cache)).toBe('1700000000000-deadbeef');
  });
});

describe('bumpTrendingCacheVersion', () => {
  it('writes a fresh unique value and returns it', async () => {
    const cache = makeFakeKV();
    const next = await bumpTrendingCacheVersion(cache);
    expect(next).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(await getTrendingCacheVersion(cache)).toBe(next);
  });

  it('produces a distinct value on every call (no read-modify-write race)', async () => {
    const cache = makeFakeKV();
    const a = await bumpTrendingCacheVersion(cache);
    const b = await bumpTrendingCacheVersion(cache);
    expect(a).not.toBe(b);
  });

  it('produces distinct values across concurrent bumps', async () => {
    const cache = makeFakeKV();
    const results = await Promise.all([
      bumpTrendingCacheVersion(cache),
      bumpTrendingCacheVersion(cache),
      bumpTrendingCacheVersion(cache),
      bumpTrendingCacheVersion(cache),
    ]);
    expect(new Set(results).size).toBe(results.length);
  });

  it('invalidates the prior cache key by emitting a new one', async () => {
    const cache = makeFakeKV();
    const before = await getTrendingCacheVersion(cache);
    await bumpTrendingCacheVersion(cache);
    const after = await getTrendingCacheVersion(cache);
    expect(trendingCacheKey(before, 12)).not.toBe(trendingCacheKey(after, 12));
  });

  it('swallows KV rate-limit errors so the request path stays alive', async () => {
    const cache = makeRateLimitedKV();
    await expect(bumpTrendingCacheVersion(cache)).resolves.toMatch(/^\d+-[0-9a-f]{8}$/);
  });
});

describe('TRENDING_CACHE_TTL_SECONDS', () => {
  it('matches the documented 5-minute window', () => {
    expect(TRENDING_CACHE_TTL_SECONDS).toBe(300);
  });
});
