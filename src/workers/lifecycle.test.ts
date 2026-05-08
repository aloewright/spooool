import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lifecycleRoutes, type LifecycleEnv } from './lifecycle';

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type SessionUser = { id: string; email: string; name?: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: LifecycleEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', lifecycleRoutes);
  return app;
}

function envFor(extra: Partial<LifecycleEnv> = {}): LifecycleEnv {
  return { DB: {} as D1Database, ...extra };
}

describe('POST /api/lifecycle/sync', () => {
  it('401s when there is no session', async () => {
    const res = await buildApp(null).request(
      '/api/lifecycle/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor(),
    );
    expect(res.status).toBe(401);
  });

  it('reports a skipped contact result when RESEND_API_KEY is missing', async () => {
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice Wright' }).request(
      '/api/lifecycle/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contact: { skipped: boolean }; event: unknown };
    expect(body.contact.skipped).toBe(true);
    expect(body.event).toBeNull();
  });

  it('upserts the contact with first-name extracted', async () => {
    const captured: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        body: JSON.parse((init?.body as string) ?? '{}'),
      });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice Wright' }).request(
      '/api/lifecycle/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor({ RESEND_API_KEY: 're_k', RESEND_AUDIENCE_ID: 'aud_1' }),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('PATCH');
    expect(captured[0].url).toBe('https://api.resend.com/audiences/aud_1/contacts/a%40x.test');
    expect(captured[0].body).toMatchObject({
      email: 'a@x.test',
      first_name: 'Alice',
      unsubscribed: false,
    });
  });

  it('also sends the welcome email when isNewSignup=true', async () => {
    const captured: Array<{ url: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push({ url: input.toString() });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice' }).request(
      '/api/lifecycle/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isNewSignup: true }),
      },
      envFor({ RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1' }),
    );
    expect(res.status).toBe(200);
    const urls = captured.map((c) => c.url);
    expect(urls).toEqual([
      'https://api.resend.com/audiences/aud_1/contacts/a%40x.test',
      'https://api.resend.com/emails',
    ]);
  });

  it('returns 200 even when Resend upsert fails (lifecycle is best-effort)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'internal' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice' }).request(
      '/api/lifecycle/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor({ RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { ok: boolean; status?: number; message?: string };
    };
    expect(body.contact.ok).toBe(false);
    expect(body.contact.status).toBe(500);
    expect(body.contact.message).toBe('internal');
  });

  it('treats an empty/no body as the same as {}', async () => {
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice' }).request(
      '/api/lifecycle/sync',
      { method: 'POST' },
      envFor(),
    );
    expect(res.status).toBe(200);
  });
});
