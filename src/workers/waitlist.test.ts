import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { waitlistRoutes, type WaitlistEnv } from './waitlist';

interface FakeStore {
  rows: Array<{ id: string; email: string; source: string; referrer: string | null; created_at: number }>;
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(store: FakeStore): D1Database {
  return {
    prepare(sql: string): PreparedStmt {
      let bound: unknown[] = [];
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const api: PreparedStmt = {
        bind(...v) {
          bound = v;
          return api;
        },
        async first() {
          if (trimmed.startsWith('SELECT COUNT(*)')) {
            return { count: store.rows.length } as never;
          }
          return null;
        },
        async run() {
          if (trimmed.startsWith('INSERT OR IGNORE INTO waitlist')) {
            const [id, email, source, referrer, created_at] = bound as [
              string,
              string,
              string,
              string | null,
              number,
            ];
            const exists = store.rows.some((r) => r.email === email);
            if (!exists) {
              store.rows.push({ id, email, source, referrer, created_at });
            }
            return { success: true };
          }
          return { success: true };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function envFor(store: FakeStore, extra: Partial<WaitlistEnv> = {}): WaitlistEnv {
  return { DB: fakeDB(store), ...extra };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildApp(env: WaitlistEnv) {
  const app = new Hono<{ Bindings: WaitlistEnv }>();
  app.route('/', waitlistRoutes);
  return { app, env };
}

describe('POST /api/waitlist', () => {
  it('400s on invalid email', async () => {
    const store: FakeStore = { rows: [] };
    const { app, env } = buildApp(envFor(store));
    const res = await app.request(
      '/api/waitlist',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it('inserts a row, normalizes email to lowercase, and returns 201', async () => {
    const store: FakeStore = { rows: [] };
    const { app, env } = buildApp(envFor(store));
    const res = await app.request(
      '/api/waitlist',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Alice@Example.com', source: 'pricing' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].email).toBe('alice@example.com');
    expect(store.rows[0].source).toBe('pricing');
    expect(store.rows[0].referrer).toBeNull();
    const body = (await res.json()) as { ok: boolean; synced: boolean };
    expect(body.ok).toBe(true);
    expect(body.synced).toBe(false);
  });

  it('is idempotent — duplicate email returns 201 without a second row', async () => {
    const store: FakeStore = { rows: [] };
    const { app, env } = buildApp(envFor(store));
    const body = JSON.stringify({ email: 'a@b.test' });
    const headers = { 'content-type': 'application/json' };
    await app.request('/api/waitlist', { method: 'POST', headers, body }, env);
    const second = await app.request('/api/waitlist', { method: 'POST', headers, body }, env);
    expect(second.status).toBe(201);
    expect(store.rows).toHaveLength(1);
  });

  it('best-effort syncs to Resend when keys are configured', async () => {
    const store: FakeStore = { rows: [] };
    const captured: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: input.toString(), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const { app, env } = buildApp(
      envFor(store, { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud' }),
    );
    const res = await app.request(
      '/api/waitlist',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.test' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; synced: boolean };
    expect(body.synced).toBe(true);
    expect(captured.some((c) => c.url.includes('/audiences/aud/contacts/'))).toBe(true);
  });

  it('returns 201 even when Resend sync fails (best-effort)', async () => {
    const store: FakeStore = { rows: [] };
    globalThis.fetch = vi.fn(async () => new Response('{"message":"down"}', { status: 500 })) as unknown as typeof fetch;

    const { app, env } = buildApp(
      envFor(store, { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud' }),
    );
    const res = await app.request(
      '/api/waitlist',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.test' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(store.rows).toHaveLength(1);
    const body = (await res.json()) as { ok: boolean; synced: boolean };
    expect(body.synced).toBe(false);
  });
});

describe('GET /api/waitlist/count', () => {
  it('reports the row count', async () => {
    const store: FakeStore = {
      rows: [
        { id: '1', email: 'a@b.test', source: 'web', referrer: null, created_at: 1 },
        { id: '2', email: 'c@d.test', source: 'web', referrer: null, created_at: 2 },
      ],
    };
    const { app, env } = buildApp(envFor(store));
    const res = await app.request('/api/waitlist/count', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(2);
  });
});
