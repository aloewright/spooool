import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { lifecycleRoutes, type LifecycleEnv } from './lifecycle';
import type { EmailBinding } from './email';

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

function fakeEmailBinding(
  impl: (msg: Parameters<EmailBinding['send']>[0]) => Promise<{ messageId?: string }> = async () => ({
    messageId: 'msg-1',
  }),
): EmailBinding & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(impl) } as never;
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

  it('no-ops (welcome: null) when isNewSignup is false / missing', async () => {
    const binding = fakeEmailBinding();
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice Wright' }).request(
      '/api/lifecycle/sync',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor({ EMAIL: binding }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { welcome: unknown };
    expect(body.welcome).toBeNull();
    expect(binding.send).not.toHaveBeenCalled();
  });

  it('sends the welcome email with first-name extracted when isNewSignup=true', async () => {
    const binding = fakeEmailBinding();
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice Wright' }).request(
      '/api/lifecycle/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isNewSignup: true }),
      },
      envFor({ EMAIL: binding, EMAIL_FROM: 'noreply@spooool.com', EMAIL_FROM_NAME: 'Spooool' }),
    );
    expect(res.status).toBe(200);
    expect(binding.send).toHaveBeenCalledTimes(1);
    const sent = binding.send.mock.calls[0][0];
    expect(sent.to).toBe('a@x.test');
    expect(sent.from).toEqual({ email: 'noreply@spooool.com', name: 'Spooool' });
    expect(sent.subject).toMatch(/welcome/i);
    expect(sent.text).toContain('Alice');
  });

  it('reports skipped result when EMAIL binding is missing (welcome still attempted)', async () => {
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice' }).request(
      '/api/lifecycle/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isNewSignup: true }),
      },
      envFor(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { welcome: { ok: boolean; skipped: boolean; reason?: string } };
    expect(body.welcome.ok).toBe(false);
    expect(body.welcome.skipped).toBe(true);
    expect(body.welcome.reason).toMatch(/EMAIL binding/i);
  });

  it('returns 200 even when the email binding throws (best-effort)', async () => {
    const binding = fakeEmailBinding(async () => {
      throw new Error('boom');
    });
    const res = await buildApp({ id: 'u1', email: 'a@x.test', name: 'Alice' }).request(
      '/api/lifecycle/sync',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isNewSignup: true }),
      },
      envFor({ EMAIL: binding }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { welcome: { ok: boolean; message?: string } };
    expect(body.welcome.ok).toBe(false);
    expect(body.welcome.message).toContain('boom');
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
