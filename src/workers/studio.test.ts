import { describe, expect, it, vi } from 'vitest';
import { studioRoutes } from './studio';

interface DbRun { sql: string; bound: unknown[] }

function fakeDB() {
  const runs: DbRun[] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => { bound = values; return stmt; },
      run: async () => { runs.push({ sql, bound: [...bound] }); return { meta: { changes: 1 } }; },
    };
    return stmt;
  };
  return { prepare, runs } as unknown as D1Database & { runs: DbRun[] };
}

function fakeQueue() {
  const sent: unknown[] = [];
  return {
    send: vi.fn(async (body: unknown) => { sent.push(body); }),
    sent,
  };
}

function makeEnv(db: D1Database, queue: ReturnType<typeof fakeQueue>) {
  return { DB: db, AI_GEN: queue };
}

function authedRequest(body: unknown) {
  return new Request('http://localhost/api/studio/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function dispatch(body: unknown, opts?: { emailVerified?: boolean }) {
  const db = fakeDB();
  const queue = fakeQueue();
  const env = makeEnv(db as unknown as D1Database, queue);

  // Inject a fake authenticated user via Hono variable by wrapping the app.
  const app = studioRoutes.clone();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user-42', emailVerified: opts?.emailVerified ?? true });
    await next();
  });

  // Mount original routes on the cloned instance then dispatch.
  const res = await studioRoutes.fetch(
    authedRequest(body),
    // Pass env + user variables via a stub that injects the user via middleware.
    { ...env } as unknown as typeof env,
  );
  return { res, db, queue };
}

// Use a standalone approach: build a mini Hono app with the user already set.
async function call(
  body: unknown,
  opts?: { emailVerified?: boolean; authenticated?: boolean },
) {
  const db = fakeDB();
  const queue = fakeQueue();
  const env = makeEnv(db as unknown as D1Database, queue);

  const { Hono } = await import('hono');
  const app = new Hono<{ Bindings: typeof env; Variables: { user: { id: string; emailVerified: boolean } | null } }>();

  app.use('*', async (c, next) => {
    const authenticated = opts?.authenticated ?? true;
    c.set('user', authenticated ? { id: 'user-42', emailVerified: opts?.emailVerified ?? true } : null);
    await next();
  });
  app.route('/', studioRoutes);

  const req = authedRequest(body);
  const res = await app.fetch(req, env);
  return { res, db, queue };
}

describe('POST /api/studio/video', () => {
  it('returns 401 when unauthenticated', async () => {
    const { res } = await call({ prompt: 'test' }, { authenticated: false });
    expect(res.status).toBe(401);
  });

  it('returns 403 when email not verified', async () => {
    const { res } = await call({ prompt: 'test' }, { emailVerified: false });
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid body (missing prompt)', async () => {
    const { res } = await call({ duration: 5 });
    expect(res.status).toBe(400);
  });

  it('inserts a generated_assets row with status=queued and returns 202 with assetId', async () => {
    const { res, db } = await call({ prompt: 'ocean waves', duration: 5 });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { assetId: string };
    expect(typeof json.assetId).toBe('string');
    expect(json.assetId.length).toBeGreaterThan(0);

    const inserts = db.runs.filter((r) => r.sql.includes('INSERT INTO generated_assets'));
    expect(inserts).toHaveLength(1);
    const b = inserts[0].bound as unknown[];
    expect(b[0]).toBe(json.assetId);  // id
    expect(b[1]).toBe('user-42');      // user_id
    expect(b[2]).toBe('video');        // kind
    expect(b[3]).toBe('video_gen');    // source
    expect(b[4]).toBe('queued');       // status
  });

  it('enqueues an AI_GEN message with assetId, userId, and prompt', async () => {
    const { res, queue } = await call({
      prompt: 'sunset timelapse',
      duration: 8,
      aspect_ratio: '16:9',
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { assetId: string };

    expect(queue.send).toHaveBeenCalledTimes(1);
    const msg = queue.sent[0] as Record<string, unknown>;
    expect(msg.assetId).toBe(json.assetId);
    expect(msg.userId).toBe('user-42');
    expect(msg.prompt).toBe('sunset timelapse');
    expect(msg.duration).toBe(8);
    expect(msg.aspect_ratio).toBe('16:9');
  });

  it('rejects unknown aspect_ratio values', async () => {
    const { res } = await call({ prompt: 'test', aspect_ratio: '21:9' });
    expect(res.status).toBe(400);
  });
});
