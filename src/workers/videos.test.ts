import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from './videos';

// ALO-128: tests for the email-verification upload gate. The check fires
// before any DB/R2/queue work, so we don't need to mock those bindings.
describe('upload email-verification gate', () => {
  function mountWithUser(user: {
    id: string;
    email: string;
    name: string;
    emailVerified?: boolean;
  } | null) {
    const app = new Hono<{ Bindings: VideoRoutesEnv; Variables: { user: typeof user } }>();
    app.use('*', async (c, next) => {
      c.set('user', user);
      await next();
    });
    app.route('/', videoRoutes);
    return app;
  }

  it('returns 403 with code=email_unverified when emailVerified=false', async () => {
    const app = mountWithUser({ id: 'u1', email: 'a@b.com', name: 'A', emailVerified: false });
    const fd = new FormData();
    fd.set('title', 'hi');
    fd.set('description', '');
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'video/mp4' }), 'clip.mp4');
    const res = await app.request('/api/videos/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('email_unverified');
  });

  it('returns 401 when no session', async () => {
    const app = mountWithUser(null);
    const res = await app.request('/api/videos/upload', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(401);
  });

  it('does not gate when emailVerified=true (passes through to validation)', async () => {
    const app = mountWithUser({ id: 'u1', email: 'a@b.com', name: 'A', emailVerified: true });
    const res = await app.request('/api/videos/upload', { method: 'POST', body: new FormData() });
    // No file attached → 400 at validation, NOT 403 from the gate.
    expect(res.status).toBe(400);
  });

  it('treats undefined emailVerified as verified (legacy callers)', async () => {
    const app = mountWithUser({ id: 'u1', email: 'a@b.com', name: 'A' });
    const res = await app.request('/api/videos/upload', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });
});
