import { describe, expect, it } from 'vitest';
import {
  MATERIALIZED_TRENDING_KEY,
  TRENDING_CACHE_TTL_SECONDS,
  TRENDING_MATERIALIZE_INTERVAL_MINUTES,
  bumpTrendingCacheVersion,
  computeTrendingScore,
  getMaterializedTrending,
  getTrendingCacheVersion,
  materializeTrending,
  rankTrending,
  type TrendingVideoRow,
  trendingCacheKey,
} from './trending-cache';

function row(overrides: Partial<TrendingVideoRow> = {}): TrendingVideoRow {
  return {
    id: 'v1',
    user_id: 'u1',
    title: 't',
    description: '',
    stream_video_id: null,
    thumbnail_url: null,
    view_count: 0,
    created_at: new Date().toISOString(),
    channel_name: null,
    recent_views: 0,
    ...overrides,
  };
}

function makeFakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
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

describe('computeTrendingScore', () => {
  const NOW = Date.parse('2026-05-08T12:00:00Z');

  it('rewards recent views over old ones at equal counts', () => {
    const fresh = computeTrendingScore(10, '2026-05-08T11:00:00Z', NOW);
    const old = computeTrendingScore(10, '2026-04-08T11:00:00Z', NOW);
    expect(fresh).toBeGreaterThan(old);
  });

  it('rewards more views at the same age', () => {
    const more = computeTrendingScore(100, '2026-05-08T00:00:00Z', NOW);
    const fewer = computeTrendingScore(10, '2026-05-08T00:00:00Z', NOW);
    expect(more).toBeGreaterThan(fewer);
  });

  it('returns 0 for an unparseable timestamp instead of NaN', () => {
    expect(computeTrendingScore(5, 'not a date', NOW)).toBe(0);
  });
});

describe('rankTrending', () => {
  const NOW = Date.parse('2026-05-08T12:00:00Z');

  it('sorts by views × recency, fresher beats older when views match', () => {
    const ranked = rankTrending(
      [
        row({ id: 'old', recent_views: 50, created_at: '2026-04-01T00:00:00Z' }),
        row({ id: 'new', recent_views: 50, created_at: '2026-05-08T06:00:00Z' }),
      ],
      2,
      NOW,
    );
    expect(ranked[0].id).toBe('new');
  });

  it('respects the limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `v${i}`, recent_views: i, created_at: '2026-05-08T00:00:00Z' }),
    );
    expect(rankTrending(rows, 3, NOW)).toHaveLength(3);
  });

  it('does not throw when a row has an unparseable created_at', () => {
    const rows = [
      row({ id: 'good', recent_views: 5, created_at: '2026-05-08T00:00:00Z' }),
      row({ id: 'bad', recent_views: 5, created_at: 'not-a-date' }),
    ];
    const ranked = rankTrending(rows, 5, NOW);
    expect(ranked.map((v) => v.id)).toEqual(['good', 'bad']);
  });
});

describe('materializeTrending', () => {
  function makeFakeDB(rows: TrendingVideoRow[]): D1Database {
    return {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    } as unknown as D1Database;
  }

  it('writes the ranked list under the materialized key', async () => {
    const db = makeFakeDB([
      row({ id: 'a', recent_views: 5, created_at: '2026-05-08T00:00:00Z' }),
      row({ id: 'b', recent_views: 50, created_at: '2026-05-08T00:00:00Z' }),
    ]);
    const cache = makeFakeKV();
    const { count } = await materializeTrending({ DB: db, CACHE: cache });
    expect(count).toBe(2);
    const stored = await getMaterializedTrending(cache);
    expect(stored).not.toBeNull();
    expect(stored?.[0]?.id).toBe('b');
    expect(stored?.[0]).toHaveProperty('score');
  });

  it('exposes a 10-minute cadence constant in sync with wrangler.toml', () => {
    expect(TRENDING_MATERIALIZE_INTERVAL_MINUTES).toBe(10);
  });

  it('writes under a stable key independent of the version cache buster', () => {
    expect(MATERIALIZED_TRENDING_KEY).toBe('trending:materialized');
  });
});
