import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeCache, purgeEdgeCache, purgeTrendingEdgeCache, type EdgeCacheOptions } from './edge-cache';

// Minimal in-memory stand-in for caches.default. The middleware only relies
// on match/put/delete, keyed by request URL.
class FakeCache {
  store = new Map<string, Response>();
  match = vi.fn(async (req: Request): Promise<Response | undefined> => {
    const found = this.store.get(req.url);
    return found ? found.clone() : undefined;
  });
  put = vi.fn(async (req: Request, res: Response): Promise<void> => {
    this.store.set(req.url, res);
  });
  delete = vi.fn(async (req: Request): Promise<boolean> => this.store.delete(req.url));
}

const globals = globalThis as { caches?: unknown };
let fake: FakeCache;

// waitUntilBackground falls back to a floating promise outside the Workers
// runtime — yield to the macrotask queue so cache.put/delete settle.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fake = new FakeCache();
  globals.caches = { default: fake };
});

afterEach(() => {
  delete globals.caches;
});

function makeApp(opts: EdgeCacheOptions = { ttl: 60, swr: 300 }) {
  const app = new Hono();
  const handler = vi.fn();
  app.get('/api/test', edgeCache(opts), (c) => {
    handler();
    return c.json({ ok: true });
  });
  return { app, handler };
}

describe('edgeCache middleware', () => {
  it('MISS: runs the handler, tags the response, and stores it', async () => {
    const { app, handler } = makeApp();
    const res = await app.request('https://x.test/api/test');
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('CF-Edge-Cache')).toBe('MISS');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.put).toHaveBeenCalledTimes(1);
    expect(fake.store.has('https://x.test/api/test')).toBe(true);
  });

  it('HIT: serves the stored response without invoking the handler', async () => {
    const { app, handler } = makeApp();
    await app.request('https://x.test/api/test');
    await flush();

    const res = await app.request('https://x.test/api/test');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.headers.get('CF-Edge-Cache')).toBe('HIT');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keys the cache by full URL including query string', async () => {
    const { app, handler } = makeApp();
    await app.request('https://x.test/api/test?limit=12');
    await flush();
    await app.request('https://x.test/api/test?limit=24');
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(fake.store.has('https://x.test/api/test?limit=12')).toBe(true);
    expect(fake.store.has('https://x.test/api/test?limit=24')).toBe(true);
  });

  it('bypasses non-GET requests entirely', async () => {
    const app = new Hono();
    app.post('/api/test', edgeCache({ ttl: 60 }), (c) => c.json({ ok: true }));
    const res = await app.request('https://x.test/api/test', { method: 'POST' });
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('CF-Edge-Cache')).toBeNull();
    expect(fake.match).not.toHaveBeenCalled();
    expect(fake.put).not.toHaveBeenCalled();
  });

  it('does not store non-2xx responses', async () => {
    const app = new Hono();
    app.get('/api/missing', edgeCache({ ttl: 60 }), (c) => c.json({ error: 'nope' }, 404));
    const res = await app.request('https://x.test/api/missing');
    await flush();

    expect(res.status).toBe(404);
    expect(fake.put).not.toHaveBeenCalled();
  });

  it('strips Set-Cookie from the stored copy but keeps it on the client response', async () => {
    const app = new Hono();
    app.get('/api/test', edgeCache({ ttl: 60 }), (c) => {
      c.header('Set-Cookie', 'anon_session=abc; Path=/');
      return c.json({ ok: true });
    });
    const res = await app.request('https://x.test/api/test');
    await flush();

    expect(res.headers.get('Set-Cookie')).toBe('anon_session=abc; Path=/');
    const stored = fake.store.get('https://x.test/api/test');
    expect(stored).toBeDefined();
    expect(stored!.headers.get('Set-Cookie')).toBeNull();
  });

  it('appends immutable for content-addressed assets', async () => {
    const { app } = makeApp({ ttl: 31536000, immutable: true });
    const res = await app.request('https://x.test/api/test');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('omits stale-while-revalidate when swr is not set', async () => {
    const { app } = makeApp({ ttl: 30 });
    const res = await app.request('https://x.test/api/test');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('passes through untouched when the caches global is absent', async () => {
    delete globals.caches;
    const { app, handler } = makeApp();
    const res = await app.request('https://x.test/api/test');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('CF-Edge-Cache')).toBeNull();
  });
});

describe('purgeEdgeCache', () => {
  function purgeApp(urls: string[]) {
    const app = new Hono();
    app.post('/api/mutate', (c) => {
      purgeEdgeCache(c, ...urls);
      return c.json({ ok: true });
    });
    return app;
  }

  it('deletes every given URL from the edge cache', async () => {
    const app = purgeApp(['https://x.test/api/channels/jo', 'https://x.test/api/tags']);
    await app.request('https://x.test/api/mutate', { method: 'POST' });
    await flush();

    expect(fake.delete).toHaveBeenCalledTimes(2);
    const deleted = fake.delete.mock.calls.map(([req]) => req.url);
    expect(deleted).toEqual(['https://x.test/api/channels/jo', 'https://x.test/api/tags']);
  });

  it('is a no-op with no URLs', async () => {
    const app = purgeApp([]);
    await app.request('https://x.test/api/mutate', { method: 'POST' });
    await flush();
    expect(fake.delete).not.toHaveBeenCalled();
  });

  it('is a no-op when the caches global is absent', async () => {
    delete globals.caches;
    const app = purgeApp(['https://x.test/api/tags']);
    const res = await app.request('https://x.test/api/mutate', { method: 'POST' });
    await flush();
    expect(res.status).toBe(200);
  });
});

describe('purgeTrendingEdgeCache', () => {
  it('purges the bare and default-limit trending variants for the request origin', async () => {
    const app = new Hono();
    app.post('/api/webhooks/encode', (c) => {
      purgeTrendingEdgeCache(c);
      return c.json({ ok: true });
    });
    await app.request('https://x.test/api/webhooks/encode', { method: 'POST' });
    await flush();

    const deleted = fake.delete.mock.calls.map(([req]) => req.url);
    expect(deleted).toEqual([
      'https://x.test/api/videos/trending',
      'https://x.test/api/videos/trending?limit=12',
    ]);
  });
});
