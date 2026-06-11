// Cloudflare Cache API middleware for edge-cached GET responses.
//
// Uses caches.default (the per-PoP edge cache) as a read-through layer in
// front of KV/D1. Cache misses fall through to the route handler; hits return
// instantly without invoking downstream middleware or the database.
//
// Invalidation strategy:
//   - Short TTLs (30–300 s) + stale-while-revalidate bound staleness for
//     semi-static content that changes via background events.
//   - Explicit purgeEdgeCache() calls in write handlers (DELETE, etc.) for
//     content that must go stale immediately on mutation.
//
// Static assets (avatars, banners) use immutable keys (UUID-named files) so
// they are safe to cache at ttl=31536000,immutable with no invalidation path.

import type { Context, MiddlewareHandler } from 'hono';
import { waitUntilBackground } from './wait-until';

export interface EdgeCacheOptions {
  /** Seconds to serve fresh responses (max-age). */
  ttl: number;
  /** Extra seconds to serve stale responses while revalidating. */
  swr?: number;
  /** When true, append `immutable` to Cache-Control (for content-addressed assets). */
  immutable?: boolean;
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
 *
 * Set-Cookie is stripped from stored responses so per-user tokens never
 * enter a shared edge cache.
 */
export function edgeCache(opts: EdgeCacheOptions): MiddlewareHandler {
  const parts = [`public`, `max-age=${opts.ttl}`];
  if (opts.swr) parts.push(`stale-while-revalidate=${opts.swr}`);
  if (opts.immutable) parts.push('immutable');
  const cacheControl = parts.join(', ');

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

    const status = c.res.status;
    // Tee the stream: one copy goes to the client, one to the cache.
    const [clientBody, cacheBody] = c.res.body.tee();

    const clientHeaders = new Headers(c.res.headers);
    clientHeaders.set('Cache-Control', cacheControl);
    clientHeaders.set('CF-Edge-Cache', 'MISS');
    c.res = new Response(clientBody, { status, headers: clientHeaders });

    // Strip Set-Cookie before storing so per-user tokens (e.g. anon view-count
    // dedup session IDs) never leak into a shared edge cache entry.
    const cacheHeaders = new Headers(clientHeaders);
    cacheHeaders.delete('Set-Cookie');
    waitUntilBackground(c as Context, cache.put(cacheKey, new Response(cacheBody, { status, headers: cacheHeaders })));
  };
}

/**
 * Schedule deletion of one or more URLs from the Workers edge cache.
 * Call this after any mutation that invalidates a cached GET response.
 * URLs must be absolute. The delete is fire-and-forget via waitUntil so it
 * never delays the mutation response.
 */
export function purgeEdgeCache(c: Context, ...urls: string[]): void {
  if (urls.length === 0 || typeof caches === 'undefined') return;
  const cache = caches.default;
  waitUntilBackground(
    c,
    Promise.all(urls.map((url) => cache.delete(new Request(url)))).then(() => undefined),
  );
}

/**
 * Purge the most common trending endpoint variants for the current origin.
 * Called after upload or delete so the trending list reflects the change
 * within the stale-while-revalidate window rather than waiting a full TTL.
 *
 * Only the default limit (12) is purged; other limits expire on their TTL.
 */
export function purgeTrendingEdgeCache(c: Context): void {
  const origin = new URL(c.req.url).origin;
  purgeEdgeCache(
    c,
    `${origin}/api/videos/trending`,
    `${origin}/api/videos/trending?limit=12`,
  );
}
