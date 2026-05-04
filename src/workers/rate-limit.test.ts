import { describe, expect, it } from 'vitest';
import {
  AUTH_WRITE_BUCKET,
  SEARCH_BUCKET,
  UPLOAD_INIT_BUCKET,
  clientIp,
  rateLimit,
  rateLimitHeaders,
} from './rate-limit';

interface FakeStub {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function fakeNs(stub: FakeStub | (() => FakeStub)): {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => DurableObjectStub;
} {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => (typeof stub === 'function' ? stub() : stub) as unknown as DurableObjectStub,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

describe('rateLimit', () => {
  it('passes the bucket config to the DO via JSON body', async () => {
    let captured: { capacity?: unknown; refillPerSecond?: unknown } | null = null;
    const stub: FakeStub = {
      fetch: async (_url, init) => {
        captured = JSON.parse((init?.body as string) ?? '{}');
        return jsonResponse({
          allowed: true,
          remaining: 9,
          limit: 10,
          retryAfterMs: 0,
          resetMs: 1_000,
        });
      },
    };
    const result = await rateLimit({ ns: fakeNs(stub), bucket: AUTH_WRITE_BUCKET, identity: 'ip:1.2.3.4' });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
    expect(captured).not.toBeNull();
    expect(captured?.capacity).toBe(AUTH_WRITE_BUCKET.capacity);
    expect(captured?.refillPerSecond).toBe(AUTH_WRITE_BUCKET.refillPerSecond);
  });

  it('addresses the DO with bucket-name + identity composite key', async () => {
    let observedName = '';
    const ns = {
      idFromName: (name: string) => {
        observedName = name;
        return name as unknown as DurableObjectId;
      },
      get: () =>
        ({
          fetch: async () =>
            jsonResponse({ allowed: true, remaining: 0, limit: 1, retryAfterMs: 0, resetMs: 0 }),
        }) as unknown as DurableObjectStub,
    };
    await rateLimit({ ns, bucket: SEARCH_BUCKET, identity: 'u:abc' });
    expect(observedName).toBe('search:u:abc');
  });

  it('translates retryAfterMs to ceil(retryAfterSeconds), with a 1s floor', async () => {
    const stub: FakeStub = {
      fetch: async () =>
        jsonResponse({ allowed: false, remaining: 0, limit: 10, retryAfterMs: 250, resetMs: 30_000 }),
    };
    const result = await rateLimit({ ns: fakeNs(stub), bucket: AUTH_WRITE_BUCKET, identity: 'x' });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(1);
  });

  it('fails open when the binding is missing (local dev path)', async () => {
    const result = await rateLimit({ ns: undefined, bucket: AUTH_WRITE_BUCKET, identity: 'x' });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(AUTH_WRITE_BUCKET.capacity);
  });

  it('fails open when the DO returns non-2xx', async () => {
    const stub: FakeStub = {
      fetch: async () => new Response('boom', { status: 500 }),
    };
    const result = await rateLimit({ ns: fakeNs(stub), bucket: AUTH_WRITE_BUCKET, identity: 'x' });
    expect(result.allowed).toBe(true);
  });

  it('fails open when the DO call throws', async () => {
    const stub: FakeStub = {
      fetch: async () => {
        throw new Error('connection reset');
      },
    };
    const result = await rateLimit({ ns: fakeNs(stub), bucket: AUTH_WRITE_BUCKET, identity: 'x' });
    expect(result.allowed).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers cf-connecting-ip', () => {
    const req = new Request('https://x.test', {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
    });
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to the first x-forwarded-for hop', () => {
    const req = new Request('https://x.test', {
      headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' },
    });
    expect(clientIp(req)).toBe('9.9.9.9');
  });

  it('returns "unknown" when no client-ip header is set', () => {
    const req = new Request('https://x.test');
    expect(clientIp(req)).toBe('unknown');
  });
});

describe('rateLimitHeaders', () => {
  it('emits RateLimit-Limit and RateLimit-Remaining when allowed', () => {
    const h = rateLimitHeaders({ allowed: true, remaining: 5, limit: 10, retryAfterSeconds: 0 });
    expect(h['RateLimit-Limit']).toBe('10');
    expect(h['RateLimit-Remaining']).toBe('5');
    expect(h['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After only when denied with a positive cooldown', () => {
    const h = rateLimitHeaders({ allowed: false, remaining: 0, limit: 10, retryAfterSeconds: 30 });
    expect(h['Retry-After']).toBe('30');
  });
});

describe('bucket configurations', () => {
  it('AUTH_WRITE_BUCKET refills 10 tokens over 5 minutes', () => {
    expect(AUTH_WRITE_BUCKET.capacity).toBe(10);
    expect(AUTH_WRITE_BUCKET.refillPerSecond * 300).toBeCloseTo(10, 5);
  });

  it('UPLOAD_INIT_BUCKET refills 20 tokens over 1 hour', () => {
    expect(UPLOAD_INIT_BUCKET.capacity).toBe(20);
    expect(UPLOAD_INIT_BUCKET.refillPerSecond * 3600).toBeCloseTo(20, 5);
  });

  it('SEARCH_BUCKET sustains 1 search/sec with a 60-burst', () => {
    expect(SEARCH_BUCKET.capacity).toBe(60);
    expect(SEARCH_BUCKET.refillPerSecond).toBe(1);
  });
});
