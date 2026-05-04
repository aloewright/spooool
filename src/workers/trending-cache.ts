// Trending list is cached in KV with a 5-minute TTL keyed by limit. Without a
// versioning step, an upload or delete is invisible from /trending until the
// TTL elapses. KV has no prefix/pattern delete, so the version key
// (trending:version) acts as a soft cache buster: write paths rotate it and
// read paths fold it into the cache key. Old entries become unreachable and
// expire on their own TTL.
//
// The version is a fresh unique string per bump rather than a counter:
// - Avoids the read-modify-write race where two concurrent bumps both observe
//   the same `current` and write the same `next`.
// - Avoids hammering KV's 1-write-per-second-per-key limit with monotonic
//   counter writes that contend on the same key for the same value.
// Bump failures are swallowed so a failed cache invalidation can't turn a
// successful upload/delete into a 5xx after DB/R2 mutations already landed;
// the TTL bounds the staleness window in the worst case.

const TRENDING_VERSION_KEY = 'trending:version';

export const TRENDING_CACHE_TTL_SECONDS = 300;

export function trendingCacheKey(version: string, limit: number): string {
  return `trending:v${version}:limit=${limit}`;
}

export async function getTrendingCacheVersion(cache: KVNamespace): Promise<string> {
  return (await cache.get(TRENDING_VERSION_KEY)) ?? '1';
}

export async function bumpTrendingCacheVersion(cache: KVNamespace): Promise<string> {
  const next = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await cache.put(TRENDING_VERSION_KEY, next);
  } catch {
    // best-effort: TTL bounds staleness if KV rate-limits this write
  }
  return next;
}
