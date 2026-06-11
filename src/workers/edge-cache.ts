// Edge-cache middleware: wraps GET responses in the Workers Cache API with
// stale-while-revalidate semantics. Only public, unauthenticated routes with
// identical responses for all callers are eligible (see CACHE_RULES).
//
// Two-level SWR model:
//   1. CDN layer  – the outgoing Cache-Control (`s-maxage` + `stale-while-revalidate`)
//      lets Cloudflare's edge serve stale content while revalidating in the background.
//   2. Worker layer – entries are stored for `maxAge + swr` seconds; a custom
//      `x-edge-fresh-until` header tracks the freshness boundary. Stale-but-cached
//      hits are served immediately and the entry is evicted in `waitUntil()` so the
//      very next request triggers a fresh handler run.
//
// Invalidation: call `purgeEdgeCache(paths, origin)` from mutation handlers.

import type { MiddlewareHandler } from 'hono';

const CACHE_NAME = 'edge-v1';

// Internal header only stored in the cache – never forwarded to clients.
const HDR_FRESH_UNTIL = 'x-edge-fresh-until';

export interface CacheConfig {
  /** Seconds a stored response is considered fresh. */
  maxAge: number;
  /** Stale-while-revalidate window in seconds (added on top of maxAge). */
  swr: number;
}

// NOTE: /api/videos/:id is intentionally excluded. That handler runs
// view-counting side effects AND sets an anonymous session cookie via
// ensureSessionId() — both must execute per-request. The KV-layer cache
// in videos.ts already offloads the D1 round-trip.
//
// More-specific patterns must appear before general ones so the first match wins.
const CACHE_RULES: ReadonlyArray<[RegExp, CacheConfig]> = [
  [/^\/api\/videos\/trending(\?|$)/, { maxAge: 300, swr: 900 }],
  [/^\/api\/videos\/[^/?]+\/related(\?|$)/, { maxAge: 300, swr: 900 }],
  [/^\/api\/videos\/[^/?]+\/tags(\?|$)/, { maxAge: 120, swr: 600 }],
  [/^\/api\/channels\/[^/?]+\/videos(\?|$)/, { maxAge: 120, swr: 600 }],
  [/^\/api\/channels\/[^/?]+(\?|$)/, { maxAge: 120, swr: 1200 }],
  [/^\/api\/tags\/[^/?]+(\?|$)/, { maxAge: 120, swr: 600 }],
  [/^\/api\/tags(\?|$)/, { maxAge: 300, swr: 1200 }],
];

export function getEdgeCacheConfig(pathname: string): CacheConfig | null {
  for (const [pattern, config] of CACHE_RULES) {
    if (pattern.test(pathname)) return config;
  }
  return null;
}

/**
 * Hono middleware that serves eligible GET responses from the Workers Cache API.
 *
 * Mount before the session-loading middleware so cache hits skip the expensive
 * auth.api.getSession() round-trip entirely.
 *
 * @param openCacheStore  Optional cache factory — inject in tests to avoid
 *   needing to stub the `caches` global. Production callers omit this and the
 *   default `caches.open(CACHE_NAME)` is used.
 */
export const edgeCacheMiddleware = (
  openCacheStore: () => Promise<Cache> = () => caches.open(CACHE_NAME),
): MiddlewareHandler =>
  async (c, next) => {
    if (c.req.method !== 'GET') {
      await next();
      return;
    }

    const { pathname } = new URL(c.req.url);
    const config = getEdgeCacheConfig(pathname);
    if (!config) {
      await next();
      return;
    }

    const cache = await openCacheStore();
    // Full URL (including query string) is the cache key so paginated/filtered
    // variants are stored and invalidated independently.
    const cacheKey = new Request(c.req.url);
    const cached = await cache.match(cacheKey);

    if (cached) {
      const freshUntil = parseInt(cached.headers.get(HDR_FRESH_UNTIL) ?? '0');
      const now = Date.now();

      const headers = new Headers(cached.headers);
      headers.delete(HDR_FRESH_UNTIL);
      // Emit CDN-friendly Cache-Control on every response regardless of Worker
      // cache status so the upstream CDN can also apply its own SWR logic.
      headers.set('Cache-Control', `public, s-maxage=${config.maxAge}, stale-while-revalidate=${config.swr}`);

      if (now < freshUntil) {
        headers.set('CF-Edge-Cache', 'HIT');
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }

      // Stale-within-SWR: serve last-known-good immediately, evict in background
      // so the very next request gets a fresh handler run.
      headers.set('CF-Edge-Cache', 'STALE');
      // Always call delete() — register with waitUntil when context is available
      // so the eviction completes even if the response is streamed out first.
      const delPromise = cache.delete(cacheKey);
      try { c.executionCtx?.waitUntil(delPromise); } catch { /* no ExecutionContext in tests */ }
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }

    await next();

    if (c.res.status === 200) {
      const { maxAge, swr } = config;
      const freshUntil = Date.now() + maxAge * 1000;

      // clone() gives us an independent body stream for the cache entry without
      // consuming the original response body that the client will receive.
      const forCache = c.res.clone();

      // Stored entry: max-age covers the full SWR window so the Cache API keeps
      // the entry available for stale-serving after the fresh window closes.
      const storeHeaders = new Headers(forCache.headers);
      storeHeaders.set('Cache-Control', `public, max-age=${maxAge + swr}`);
      storeHeaders.set(HDR_FRESH_UNTIL, String(freshUntil));
      // Always call put() — register with waitUntil when context is available.
      const putPromise = cache.put(
        cacheKey,
        new Response(forCache.body, {
          status: 200,
          statusText: forCache.statusText,
          headers: storeHeaders,
        }),
      );
      try { c.executionCtx?.waitUntil(putPromise); } catch { /* no ExecutionContext in tests */ }

      // Mutate the client-facing headers in place (same pattern as security-headers.ts).
      c.res.headers.set('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}`);
      c.res.headers.set('CF-Edge-Cache', 'MISS');
    }
  };

/**
 * Delete specific paths from the Workers edge cache. Call this immediately after
 * any mutation that renders a cached response stale (subscribe, profile update,
 * tag update, video delete, etc.).
 *
 * Errors are swallowed – a failed purge is bounded by the SWR window, which is
 * the same contract the KV layer uses for its own invalidation failures.
 *
 * @param paths   Absolute URL paths, e.g. `['/api/channels/alice']`
 * @param origin  Full origin of the current request, e.g. `'https://spooool.tv'`
 */
export async function purgeEdgeCache(paths: string[], origin: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(paths.map((p) => cache.delete(new Request(`${origin}${p}`))));
  } catch {
    // best-effort: stale content expires within the SWR window regardless
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers for common invalidation patterns
// ---------------------------------------------------------------------------

/** Purge a single edge-cache entry by its origin + pathname. */
export function purgeEdgeCachePath(origin: string, pathname: string): Promise<void> {
  return purgeEdgeCache([pathname], origin);
}

// The SPA requests trending with limit=12 by default; also cover limit=24
// which channel/discovery pages may request.
const TRENDING_PURGE_LIMITS = [12, 24];

/** Purge all common variants of the trending edge-cache entry. */
export function purgeTrendingEdgeCache(origin: string): Promise<void> {
  return purgeEdgeCache(
    [
      '/api/videos/trending',
      ...TRENDING_PURGE_LIMITS.map((l) => `/api/videos/trending?limit=${l}`),
    ],
    origin,
  );
}
