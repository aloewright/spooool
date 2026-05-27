// ALO-168: thin client around RateLimiterDO. Routes call rateLimit(...) with
// a named bucket and an identity (user id or IP), get back an allow/deny
// decision, and use the helpers below to project standard headers + 429s.
//
// Design notes:
// - Policy lives here, not in the DO. Bucket configs (capacity + refill rate)
//   are sent on every take() so changing them doesn't require a DO migration.
// - Fail-open on missing binding or DO error. A rate limiter that can knock
//   the API offline when its own backend is sick is worse than no limiter.
// - Per-IP only for unauthenticated routes (auth-write); per-user where a
//   session exists (upload-init); per-user with IP fallback for mixed routes
//   (search).

export interface RateLimitBucket {
  name: string;
  capacity: number;
  refillPerSecond: number;
}

// 10 attempts in 5min ~= 1 every 30s sustained, burst of 10. Wraps signin,
// signup, password-reset, etc. — every state-changing /api/auth/* call.
export const AUTH_WRITE_BUCKET: RateLimitBucket = {
  name: 'auth-write',
  capacity: 10,
  refillPerSecond: 10 / 300,
};

// 20 upload inits per hour ~= 1 every 3min sustained, burst of 20. Only
// applies to chunkIndex===0; subsequent chunks of the same upload pass.
export const UPLOAD_INIT_BUCKET: RateLimitBucket = {
  name: 'upload-init',
  capacity: 20,
  refillPerSecond: 20 / 3600,
};

// 60 searches per minute = 1/sec sustained, burst of 60.
export const SEARCH_BUCKET: RateLimitBucket = {
  name: 'search',
  capacity: 60,
  refillPerSecond: 1,
};

// 5 video generations per hour per user — guards AI Gateway credit burn on the
// prompt-to-video endpoints (auto-mode + guided sessions). Per-user, not per-IP,
// so multiple users behind a NAT aren't penalized for each other's traffic.
export const CREATE_BUCKET: RateLimitBucket = {
  name: 'create',
  capacity: 5,
  refillPerSecond: 5 / 3600,
};

interface RateLimiterBinding {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

interface DOResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs: number;
  resetMs: number;
}

export async function rateLimit(args: {
  ns: RateLimiterBinding | undefined;
  bucket: RateLimitBucket;
  identity: string;
}): Promise<RateLimitResult> {
  const { ns, bucket, identity } = args;
  if (!ns) {
    return failOpen(bucket);
  }
  try {
    const id = ns.idFromName(`${bucket.name}:${identity}`);
    const stub = ns.get(id);
    const res = await stub.fetch('https://rl/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: bucket.capacity, refillPerSecond: bucket.refillPerSecond }),
    });
    if (!res.ok) {
      console.warn('rate-limit DO non-2xx', { bucket: bucket.name, status: res.status });
      return failOpen(bucket);
    }
    const data = (await res.json()) as DOResult;
    return {
      allowed: data.allowed,
      remaining: data.remaining,
      limit: data.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(data.retryAfterMs / 1000)),
    };
  } catch (err) {
    console.warn('rate-limit DO threw', {
      bucket: bucket.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return failOpen(bucket);
  }
}

function failOpen(bucket: RateLimitBucket): RateLimitResult {
  return {
    allowed: true,
    remaining: bucket.capacity,
    limit: bucket.capacity,
    retryAfterSeconds: 0,
  };
}

// IP extraction. cf-connecting-ip is set by Cloudflare on every edge request;
// the x-forwarded-for fallback covers local dev / non-edge environments.
// Returns 'unknown' rather than empty so the DO key never collapses identities.
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf && cf.length > 0) return cf;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
  };
  if (!result.allowed && result.retryAfterSeconds > 0) {
    h['Retry-After'] = String(result.retryAfterSeconds);
  }
  return h;
}
