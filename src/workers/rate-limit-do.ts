// ALO-168: token-bucket Durable Object. One DO instance per (bucket, identity)
// pair, e.g. "auth-write:1.2.3.4" or "upload-init:user_abc". Stores tokens +
// last-refill timestamp; the bucket's capacity and refill rate live in the
// caller (so policy changes don't require a DO migration).
//
// Concurrency: blockConcurrencyWhile serialises take() calls per instance, so
// two simultaneous requests against the same identity can't both observe a
// not-yet-decremented bucket.

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TakeRequest {
  capacity: number;
  refillPerSecond: number;
  cost?: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs: number;
  resetMs: number;
}

export function computeTake(
  state: BucketState | null,
  capacity: number,
  refillPerSecond: number,
  cost: number,
  nowMs: number,
): { result: TakeResult; nextState: BucketState } {
  const lastRefillMs = state?.lastRefillMs ?? nowMs;
  const elapsedMs = Math.max(0, nowMs - lastRefillMs);
  const startTokens = state?.tokens ?? capacity;
  const refilled = Math.min(capacity, startTokens + (elapsedMs / 1000) * refillPerSecond);
  const allowed = refilled >= cost;
  const tokens = allowed ? refilled - cost : refilled;
  const deficitForRetry = allowed ? 0 : cost - refilled;
  const retryAfterMs = allowed
    ? 0
    : refillPerSecond > 0
      ? Math.ceil((deficitForRetry / refillPerSecond) * 1000)
      : Number.POSITIVE_INFINITY;
  const resetMs =
    refillPerSecond > 0 ? Math.ceil(((capacity - tokens) / refillPerSecond) * 1000) : 0;
  return {
    result: { allowed, remaining: Math.floor(tokens), limit: capacity, retryAfterMs, resetMs },
    nextState: { tokens, lastRefillMs: nowMs },
  };
}

export class RateLimiterDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/take') {
      return new Response('not found', { status: 404 });
    }
    const body = (await req.json().catch(() => null)) as TakeRequest | null;
    if (
      !body ||
      typeof body.capacity !== 'number' ||
      body.capacity <= 0 ||
      typeof body.refillPerSecond !== 'number' ||
      body.refillPerSecond <= 0
    ) {
      return new Response('bad request', { status: 400 });
    }
    const cost = typeof body.cost === 'number' && body.cost > 0 ? body.cost : 1;
    const result = await this.take(body.capacity, body.refillPerSecond, cost);
    return Response.json(result);
  }

  private async take(
    capacity: number,
    refillPerSecond: number,
    cost: number,
  ): Promise<TakeResult> {
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = (await this.state.storage.get<BucketState>('bucket')) ?? null;
      const { result, nextState } = computeTake(stored, capacity, refillPerSecond, cost, now);
      await this.state.storage.put('bucket', nextState);
      return result;
    });
  }
}
