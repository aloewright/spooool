import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { studioRoutes, type StudioEnv } from './studio';

type SessionUser = { id: string; emailVerified: boolean } | null;

vi.stubGlobal('crypto', { randomUUID: () => 'generated-asset-id' });

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: StudioEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', studioRoutes);
  return app;
}

function makeStmt() {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv(overrides: Partial<StudioEnv> = {}): StudioEnv {
  const stmt = makeStmt();
  return {
    DB: { prepare: vi.fn().mockReturnValue(stmt), _stmt: stmt } as unknown as D1Database,
    AI_GEN: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
    ...overrides,
  };
}

const VALID_BODY = JSON.stringify({ prompt: 'Ocean waves at dusk', duration: 8 });

describe('POST /api/studio/video', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await buildApp(null).request(
      '/api/studio/video',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: VALID_BODY },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when email is not verified', async () => {
    const res = await buildApp({ id: 'u1', emailVerified: false }).request(
      '/api/studio/video',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: VALID_BODY },
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 on missing prompt', async () => {
    const res = await buildApp({ id: 'u1', emailVerified: true }).request(
      '/api/studio/video',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ duration: 5 }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('inserts generated_assets row and returns 202 with assetId', async () => {
    const env = makeEnv();
    const res = await buildApp({ id: 'u1', emailVerified: true }).request(
      '/api/studio/video',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: VALID_BODY },
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { assetId: string };
    expect(body.assetId).toBe('generated-asset-id');

    // DB insert was called
    expect((env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO generated_assets'),
    );
  });

  it('enqueues a message to AI_GEN with prompt and assetId', async () => {
    const env = makeEnv();
    await buildApp({ id: 'u1', emailVerified: true }).request(
      '/api/studio/video',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: VALID_BODY },
      env,
    );

    expect((env.AI_GEN as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'generated-asset-id',
        userId: 'u1',
        prompt: 'Ocean waves at dusk',
        duration: 8,
      }),
    );
  });

  it('inserts asset with status=queued', async () => {
    const env = makeEnv();
    const db = env.DB as unknown as { prepare: ReturnType<typeof vi.fn>; _stmt: ReturnType<typeof makeStmt> };
    await buildApp({ id: 'u1', emailVerified: true }).request(
      '/api/studio/video',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: VALID_BODY },
      env,
    );

    const insertCall = db.prepare.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO generated_assets'),
    );
    expect(insertCall).toBeDefined();
    // The bound values include 'queued' as the status
    const bindArgs: unknown[] = db._stmt.bind.mock.calls.flat();
    expect(bindArgs).toContain('queued');
  });
});
