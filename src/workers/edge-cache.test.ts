import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachePolicy, edgeCacheMiddleware, purgeEdgeCachePath, purgeTrendingEdgeCache } from './edge-cache';

// ---------------------------------------------------------------------------
// getCachePolicy
// ---------------------------------------------------------------------------
describe('getCachePolicy', () => {
  it('matches /api/videos/trending', () => {
    const p = getCachePolicy('/api/videos/trending');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(60);
    expect(p!.swr).toBe(240);
  });

  it('matches /api/videos/trending with query string', () => {
    expect(getCachePolicy('/api/videos/trending?limit=24')).not.toBeNull();
  });

  it('matches /api/channels/:username', () => {
    const p = getCachePolicy('/api/channels/johndoe');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(60);
    expect(p!.swr).toBe(120);
  });

  it('matches /api/channels/:username/videos', () => {
    const p = getCachePolicy('/api/channels/johndoe/videos');
    expect(p).not.toBeNull();
    expect(p!.maxAge).toBe(30);
    expect(p!.swr).toBe(60);
  });

  it('returns null for /api/videos/:id (intentionally excluded)', () => {
    expect(getCachePolicy('/api/videos/abc123')).toBeNull();
  });

  it('returns null for /api/users/me', () => {
    expect(getCachePolicy('/api/users/me')).toBeNull();
  });

  it('returns null for /api/auth/session', () => {
    expect(getCachePolicy('/api/auth/session')).toBeNull();
  });

  it('does not match /api/channels/:username/settings (extra segment)', () => {
    // channels/:username/settings should not match channels/:username pattern
    expect(getCachePolicy('/api/channels/johndoe/settings')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// edgeCacheMiddleware
// ---------------------------------------------------------------------------

function buildTestApp(mockCache: {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}) {
  // Stub caches.default on the global so the middleware can find it
  vi.stubGlobal('caches', { default: mockCache });

  const app = new Hono();
  app.use('*', edgeCacheMiddleware());
  app.get('/api/videos/trending', (c) =>
    c.json({ videos: [{ id: '1', title: 'Test' }] }),
  );
  app.get('/api/channels/johndoe', (c) => c.json({ username: 'johndoe' }));
  app.get('/api/videos/abc123', (c) => c.json({ id: 'abc123' }));
  return app;
}

describe('edgeCacheMiddleware', () => {
  let mockCache: {
    match: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips non-GET methods', async () => {
    const app = buildTestApp(mockCache);
    app.post('/api/videos/trending', (c) => c.json({ ok: true }));
    const res = await app.request('/api/videos/trending', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockCache.match).not.toHaveBeenCalled();
  });

  it('skips routes not in policy map', async () => {
    const app = buildTestApp(mockCache);
    await app.request('/api/videos/abc123');
    expect(mockCache.match).not.toHaveBeenCalled();
  });

  it('skips authenticated requests (cookie present)', async () => {
    const app = buildTestApp(mockCache);
    await app.request('/api/videos/trending', {
      headers: { cookie: 'better-auth.session=abc' },
    });
    expect(mockCache.match).not.toHaveBeenCalled();
  });

  it('returns cached response on HIT with X-Edge-Cache: HIT header', async () => {
    const cachedResponse = new Response(JSON.stringify({ videos: [], cached: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Edge-Cache': 'HIT',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=240',
      },
    });
    mockCache.match.mockResolvedValue(cachedResponse);
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/videos/trending');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(mockCache.put).not.toHaveBeenCalled();
  });

  it('stores response in cache on MISS and sets Cache-Control', async () => {
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/videos/trending');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=240',
    );
    expect(res.headers.get('X-Edge-Cache')).toBe('MISS');
    // put is called via waitUntilBackground (ctx.waitUntil); in tests the
    // promise is fired immediately, so we can await the microtask queue.
    await vi.waitFor(() => expect(mockCache.put).toHaveBeenCalledOnce());
  });

  it('stores HIT header in the cached entry', async () => {
    const app = buildTestApp(mockCache);
    await app.request('/api/videos/trending');
    await vi.waitFor(() => expect(mockCache.put).toHaveBeenCalledOnce());
    const [, storedResponse] = mockCache.put.mock.calls[0] as [Request, Response];
    expect(storedResponse.headers.get('X-Edge-Cache')).toBe('HIT');
  });

  it('uses the correct cache policy for channel profiles', async () => {
    const app = buildTestApp(mockCache);
    const res = await app.request('/api/channels/johndoe');
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=120',
    );
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
    vi.stubGlobal('caches', { default: { delete: mockDelete } });

    await purgeEdgeCachePath('https://example.com', '/api/channels/johndoe');

    expect(mockDelete).toHaveBeenCalledOnce();
    const req = mockDelete.mock.calls[0][0] as Request;
    expect(req.url).toBe('https://example.com/api/channels/johndoe');
  });

  it('does nothing when caches is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    // Should not throw
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
    vi.stubGlobal('caches', { default: { delete: mockDelete } });

    await purgeTrendingEdgeCache('https://example.com');

    // bare + 2 limit variants = 3 calls
    expect(mockDelete).toHaveBeenCalledTimes(3);
    const urls = (mockDelete.mock.calls as Array<[Request]>).map(([r]) => r.url);
    expect(urls).toContain('https://example.com/api/videos/trending');
    expect(urls).toContain('https://example.com/api/videos/trending?limit=12');
    expect(urls).toContain('https://example.com/api/videos/trending?limit=24');
  });
});
