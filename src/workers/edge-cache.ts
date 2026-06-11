import type { MiddlewareHandler } from 'hono';
import { waitUntilBackground } from './wait-until';

export type CachePolicy = {
  maxAge: number;
  swr: number; // stale-while-revalidate
};

// Cache-Control policies for public, unauthenticated GET routes.
//
// NOTE: /api/videos/:id is intentionally excluded. That handler runs
// view-counting side effects AND sets an anonymous session cookie via
// ensureSessionId() — both must execute per-request. The KV-layer cache
// in videos.ts already offloads the D1 round-trip.
const ROUTE_POLICIES: Array<[RegExp, CachePolicy]> = [
  [/^\/api\/videos\/trending(\?.*)?$/, { maxAge: 60, swr: 240 }],
  [/^\/api\/channels\/[^/]+\/videos(\?.*)?$/, { maxAge: 30, swr: 60 }],
  [/^\/api\/channels\/[^/]+$/, { maxAge: 60, swr: 120 }],
];

export function getCachePolicy(pathname: string): CachePolicy | null {
  for (const [pattern, policy] of ROUTE_POLICIES) {
    if (pattern.test(pathname)) return policy;
  }
  return null;
}

function defaultCache(): Cache | null {
  try {
    // caches.default is undefined in local Node test runners
    return typeof caches !== 'undefined' ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Hono middleware that reads from and writes to the Cloudflare edge cache.
 *
 * Only applies to GET/HEAD requests matching `ROUTE_POLICIES` that arrive
 * without a Cookie header. Responses with status 200 are stored; the body
 * is tee-ed so the client stream and the cache stream are independent.
 */
export const edgeCacheMiddleware = (): MiddlewareHandler => async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

  const url = new URL(c.req.url);
  const policy = getCachePolicy(url.pathname);
  if (!policy) return next();

  // Bypass for authenticated requests — responses may be personalised.
  if (c.req.header('cookie')) return next();

  const cache = defaultCache();
  if (!cache) return next();

  const cacheKey = new Request(c.req.url);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: cached.headers,
    });
  }

  await next();

  if (c.res.status === 200) {
    // Clone first — both c.res.body and clone.body become independent streams.
    const forCache = c.res.clone();

    // Hono exposes c.res.headers as a mutable Headers instance (same pattern
    // used by security-headers.ts). Mutating it is safe and avoids replacing
    // the whole Response object.
    c.res.headers.set(
      'Cache-Control',
      `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`,
    );
    c.res.headers.set('X-Edge-Cache', 'MISS');

    const cacheHeaders = new Headers(forCache.headers);
    cacheHeaders.set(
      'Cache-Control',
      `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`,
    );
    cacheHeaders.set('X-Edge-Cache', 'HIT');

    waitUntilBackground(
      c,
      cache.put(
        cacheKey,
        new Response(forCache.body, { status: forCache.status, headers: cacheHeaders }),
      ),
    );
  }
};

// ---------------------------------------------------------------------------
// Purge helpers — all best-effort; failures are swallowed because a missed
// purge just means the route's max-age bounds the staleness window.
// ---------------------------------------------------------------------------

/** Purge a single edge-cache entry by its origin + pathname. */
export async function purgeEdgeCachePath(origin: string, pathname: string): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;
  try {
    await cache.delete(new Request(`${origin}${pathname}`));
  } catch {
    // best-effort
  }
}

// The SPA uses limit=12 by default; also cover the bare URL (no query string)
// and limit=24 which channel pages may request.
const TRENDING_PURGE_LIMITS = [12, 24];

/** Purge all common variants of the trending edge-cache entry. */
export async function purgeTrendingEdgeCache(origin: string): Promise<void> {
  const cache = defaultCache();
  if (!cache) return;
  const urls = [
    `${origin}/api/videos/trending`,
    ...TRENDING_PURGE_LIMITS.map((l) => `${origin}/api/videos/trending?limit=${l}`),
  ];
  await Promise.all(urls.map((u) => cache.delete(new Request(u)).catch(() => {})));
}
