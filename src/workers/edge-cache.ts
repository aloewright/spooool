import type { Context, MiddlewareHandler } from 'hono';
import { waitUntilBackground } from './wait-until';

export interface EdgeCacheOptions {
  /** Seconds to serve fresh responses (max-age). */
  ttl: number;
  /** Extra seconds to serve stale responses while revalidating. */
  swr?: number;
}

/**
 * Hono middleware that serves GET responses from the Workers Cache API
 * (caches.default). On a cache miss the handler runs normally; the 2xx
 * response is then stored with the configured Cache-Control TTL so the
 * next request is served entirely from the edge without touching the Worker.
 *
 * Only apply to routes whose response does not vary by authentication state
 * and has no per-request side-effects that must fire on every hit (e.g.
 * view-count increments).
 */
export function edgeCache(opts: EdgeCacheOptions): MiddlewareHandler {
  const swr = opts.swr ? `, stale-while-revalidate=${opts.swr}` : '';
  const cacheControl = `public, max-age=${opts.ttl}${swr}`;

  return async (c, next) => {
    // Only cache idempotent reads.
    if (c.req.method !== 'GET') {
      await next();
      return;
    }

    // caches.default is only available in the Workers runtime; degrade
    // gracefully in unit-test environments where the global is absent.
    if (typeof caches === 'undefined') {
      await next();
      return;
    }

    const cache = caches.default;
    const cacheKey = new Request(c.req.url);

    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('CF-Edge-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }

    await next();

    // Don't cache error responses or empty bodies.
    if (!c.res.ok || !c.res.body) return;

    // Tee the stream: one copy goes to the client, one to the cache.
    const [clientBody, cacheBody] = c.res.body.tee();

    const clientHeaders = new Headers(c.res.headers);
    clientHeaders.set('Cache-Control', cacheControl);
    clientHeaders.set('CF-Edge-Cache', 'MISS');
    c.res = new Response(clientBody, { status: c.res.status, headers: clientHeaders });

    const cacheHeaders = new Headers(c.res.headers);
    const toCache = new Response(cacheBody, { status: c.res.status, headers: cacheHeaders });

    waitUntilBackground(c as Context, cache.put(cacheKey, toCache));
  };
}

/**
 * Schedule deletion of one or more URLs from the Workers edge cache.
 * Call this after any mutation that invalidates a cached GET response.
 * The delete is fire-and-forget via waitUntil so it never delays the
 * mutation response.
 */
export function purgeEdgeCache(c: Context, ...urls: string[]): void {
  if (urls.length === 0 || typeof caches === 'undefined') return;
  const cache = caches.default;
  waitUntilBackground(
    c,
    Promise.all(urls.map((url) => cache.delete(new Request(url)))).then(() => undefined),
  );
}
