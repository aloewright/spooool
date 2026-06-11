import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEdgeCacheConfig,
  edgeCacheMiddleware,
  purgeEdgeCachePath,
  purgeTrendingEdgeCache,
} from './edge-cache';

// ---------------------------------------------------------------------------
// getEdgeCacheConfig
// ---------------------------------------------------------------------------
describe('getEdgeCacheConfig', () => {
  it('matches /api/videos/trending', () => {
    const p = getEdgeCacheConfig('/api/videos/trending');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(300);
    expect(p!.swr).toBe(900);
  });

  it('matches /api/videos/trending with query string', () => {
    expect(getEdgeCacheConfig('/api/videos/trending?limit=24')).not.toBeNull();
  });

  it('matches /api/channels/:username', () => {
    const p = getEdgeCacheConfig('/api/channels/johndoe');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(120);
    expect(p!.swr).toBe(1200);
  });

  it('matches /api/channels/:username/videos', () => {
    const p = getEdgeCacheConfig('/api/channels/johndoe/videos');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(120);
    expect(p!.swr).toBe(600);
  });

  it('matches /api/tags', () => {
    const p = getEdgeCacheConfig('/api/tags');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(300);
  });

  it('matches /api/tags/:slug', () => {
    expect(getEdgeCacheConfig('/api/tags/music')).not.toBeNull();
  });

  it('matches /api/videos/:id/related', () => {
    expect(getEdgeCacheConfig('/api/videos/abc123/related')).not.toBeNull();
  });

  it('matches /api/videos/:id/tags', () => {
    expect(getEdgeCacheConfig('/api/videos/abc123/tags')).not.toBeNull();
  });

  it('returns null for /api/videos/:id (intentionally excluded)', () => {
    expect(getEdgeCacheConfig('/api/videos/abc123')).toBeNull();
  });

  it('returns null for /api/users/me', () => {
    expect(getEdgeCacheConfig('/api/users/me')).toBeNull();
  });

  it('returns null for /api/auth/session', () => {
    expect(getEdgeCacheConfig('/api/auth/session')).toBeNull();
  });

  it('does not match /api/channels/:username/settings (extra segment)', () => {
    expect(getEdgeCacheConfig('/api/channels/johndoe/settings')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// edgeCacheMiddleware
// ---------------------------------------------------------------------------

type MockCache = {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function buildTestApp(mockCache: MockCache) {
  // Inject the mock cache directly via the openCacheStore factory parameter so
  // tests don't need to stub the `caches` global (which is a Workers-only API).
  const openCacheStore = () => Promise.resolve(mockCache as unknown as Cache);

  const app = new Hono();
  app.use('*', edgeCacheMiddleware(openCacheStore));
  app.get('/api/videos/trending', (c) =>
    c.json({ videos: [{ id: '1', title: 'Test' }] }),
  );
  app.get('/api/channels/johndoe', (c) => c.json({ username: 'johndoe' }));
  app.get('/api/videos/abc123', (c) => c.json({ id: 'abc123' }));
  return app;
}

/** Build a mock cached Response with an in-date freshness header. */
function freshCachedResponse(body: unknown, maxAgeSec = 300): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'CF-Edge-Cache': 'HIT',
      'Cache-Control': `public, max-age=${maxAgeSec + 900}`,
      // Set freshUntil ~5 minutes in the future so the hit path triggers.
      'x-edge-fresh-until': String(Date.now() + maxAgeSec * 1000),
    },
  });
}

describe('edgeCacheMiddleware', () => {
  let mockCache: MockCache;

  beforeEach(() => {
    mockCache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };
  });

  it('skips non-GET methods', async () => {
    const app = buildTestApp(mockCache);
    app.post('/api/videos/trending', (c) => c.json({ ok: true }));
    const res = await app.request('/api/videos/trending', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockCache.match).not.toHaveBeenCalled();
  });

  it('skips routes not in cache rules', async () => {
    const app = buildTestApp(mockCache);
    await app.request('/api/videos/abc123');
    expect(mockCache.match).not.toHaveBeenCalled();
  });

  it('returns cached response on HIT with CF-Edge-Cache: HIT header', async () => {
    mockCache.match.mockResolvedValue(freshCachedResponse({ videos: [], cached: true }));
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/videos/trending');
    expect(res.status).toBe(200);
    expect(res.headers.get('CF-Edge-Cache')).toBe('HIT');
    expect(mockCache.put).not.toHaveBeenCalled();
  });

  it('stores response in cache on MISS and sets Cache-Control', async () => {
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/videos/trending');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=900',
    );
    expect(res.headers.get('CF-Edge-Cache')).toBe('MISS');
    await vi.waitFor(() => expect(mockCache.put).toHaveBeenCalledOnce());
  });

  it('stored entry carries x-edge-fresh-until for SWR tracking', async () => {
    const app = buildTestApp(mockCache);
    const before = Date.now();
    await app.request('/api/videos/trending');
    await vi.waitFor(() => expect(mockCache.put).toHaveBeenCalledOnce());
    const [, storedResponse] = mockCache.put.mock.calls[0] as [Request, Response];
    const freshUntil = parseInt(storedResponse.headers.get('x-edge-fresh-until') ?? '0');
    expect(freshUntil).toBeGreaterThan(before);
  });

  it('uses the correct cache config for channel profiles', async () => {
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/channels/johndoe');
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=120, stale-while-revalidate=1200',
    );
  });

  it('serves stale response and evicts on STALE', async () => {
    // Fresh-until in the past (stale) but cache entry still exists (within SWR window).
    const staleResponse = new Response(JSON.stringify({ stale: true }), {
      status: 200,
      headers: {
        'x-edge-fresh-until': String(Date.now() - 1000), // expired 1s ago
        'Cache-Control': 'public, max-age=1200',
      },
    });
    mockCache.match.mockResolvedValue(staleResponse);
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/videos/trending');
    expect(res.headers.get('CF-Edge-Cache')).toBe('STALE');
    await vi.waitFor(() => expect(mockCache.delete).toHaveBeenCalledOnce());
  });
});

// ---------------------------------------------------------------------------
// purgeEdgeCachePath / purgeTrendingEdgeCache
// ---------------------------------------------------------------------------

describe('purgeEdgeCachePath', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls cache.delete with the constructed URL', async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ delete: mockDelete }) });

    await purgeEdgeCachePath('https://example.com', '/api/channels/johndoe');

    expect(mockDelete).toHaveBeenCalledOnce();
    const req = mockDelete.mock.calls[0][0] as Request;
    expect(req.url).toBe('https://example.com/api/channels/johndoe');
  });

  it('does nothing when caches throws', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockRejectedValue(new Error('unavailable')),
    });
    await expect(
      purgeEdgeCachePath('https://example.com', '/api/channels/johndoe'),
    ).resolves.toBeUndefined();
  });
});

describe('purgeTrendingEdgeCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('purges the bare URL and all limit= variants', async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ delete: mockDelete }) });

    await purgeTrendingEdgeCache('https://example.com');

    // bare + 2 limit variants = 3 calls
    expect(mockDelete).toHaveBeenCalledTimes(3);
    const urls = (mockDelete.mock.calls as Array<[Request]>).map(([r]) => r.url);
    expect(urls).toContain('https://example.com/api/videos/trending');
    expect(urls).toContain('https://example.com/api/videos/trending?limit=12');
    expect(urls).toContain('https://example.com/api/videos/trending?limit=24');
  });
});
