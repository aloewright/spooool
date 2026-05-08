import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ALO-189: integration coverage for /api/videos/* via miniflare bindings.
// Tests apply src/db/migrations to the in-memory D1, then seed minimal rows
// before driving the routes through the test worker entry. Miniflare gives
// real R2/KV/Queue/D1 implementations so the upload + trending + view-count
// paths exercise actual side effects rather than stubs.

async function resetDb(): Promise<void> {
  // Order matters: drop child rows before parents. Foreign keys are off in
  // D1 by default, but it's still cleaner to clear FKed rows first so the
  // remaining tests can rely on a known-empty state.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM views'),
    env.DB.prepare('DELETE FROM videos'),
    env.DB.prepare('DELETE FROM user'),
    env.DB.prepare('DELETE FROM users'),
  ]);
}

async function seedUser(id: string, opts: { name?: string; email?: string } = {}): Promise<void> {
  const now = Date.now();
  // Two tables exist for historical reasons: `users` (plural) from the
  // initial migration is still referenced by `videos.user_id` via FK;
  // `user` (singular) is the better-auth row our session middleware reads.
  // Seed both so FK enforcement passes and `JOIN user` lookups resolve.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, username, display_name)
       VALUES (?, ?, ?, ?)`,
    ).bind(id, opts.email ?? `${id}@example.test`, id, opts.name ?? id),
    env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(id, opts.name ?? id, opts.email ?? `${id}@example.test`, now, now),
  ]);
}

async function seedVideo(opts: {
  id: string;
  userId: string;
  title?: string;
  status?: string;
  viewCount?: number;
  hiddenAt?: string | null;
  dmcaStatus?: string | null;
}): Promise<void> {
  const r2Key = `${opts.userId}/${opts.id}/clip.mp4`;
  await env.DB.prepare(
    `INSERT INTO videos (id, user_id, title, description, r2_key, status, view_count,
                         created_at, updated_at, hidden_at, dmca_status, bytes)
     VALUES (?, ?, ?, '', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 0)`,
  )
    .bind(
      opts.id,
      opts.userId,
      opts.title ?? 'untitled',
      r2Key,
      opts.status ?? 'ready',
      opts.viewCount ?? 0,
      opts.hiddenAt ?? null,
      opts.dmcaStatus ?? null,
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  // Wipe R2 so multi-test upload runs don't leave keys behind. KV is
  // cleared by the global setup file's afterEach.
  const objects = await env.VIDEOS.list();
  await Promise.all(objects.objects.map((o: { key: string }) => env.VIDEOS.delete(o.key)));
});

describe('GET /api/videos (list)', () => {
  it('returns the active videos sorted by created_at DESC', async () => {
    await seedUser('alice');
    await seedVideo({ id: 'v1', userId: 'alice', title: 'older' });
    // Force a different created_at so DESC ordering is deterministic.
    await env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, status, view_count,
                           created_at, updated_at, bytes)
       VALUES ('v2', 'alice', 'newer', '', 'alice/v2/clip.mp4', 'ready', 0,
               datetime('now', '+1 second'), datetime('now', '+1 second'), 0)`,
    ).run();

    const res = await SELF.fetch('http://t/api/videos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; limit: number; videos: { id: string }[] };
    expect(body.page).toBe(1);
    expect(body.videos.map((v) => v.id)).toEqual(['v2', 'v1']);
  });

  it('hides soft-deleted and hidden rows', async () => {
    await seedUser('alice');
    await seedVideo({ id: 'visible', userId: 'alice' });
    await seedVideo({ id: 'hidden', userId: 'alice', hiddenAt: '2026-01-01T00:00:00Z' });
    await env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, status, view_count,
                           created_at, updated_at, deleted_at, bytes)
       VALUES ('deleted', 'alice', 'gone', '', 'alice/deleted/clip.mp4', 'ready', 0,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`,
    ).run();

    const res = await SELF.fetch('http://t/api/videos');
    const body = (await res.json()) as { videos: { id: string }[] };
    expect(body.videos.map((v) => v.id)).toEqual(['visible']);
  });
});

describe('GET /api/videos/:id', () => {
  it('returns 404 when the video does not exist', async () => {
    const res = await SELF.fetch('http://t/api/videos/missing-id');
    expect(res.status).toBe(404);
  });

  it('happy path: returns the row and increments view_count on first hit', async () => {
    await seedUser('alice');
    await seedVideo({ id: 'v1', userId: 'alice', title: 'hello', viewCount: 0 });

    const res = await SELF.fetch('http://t/api/videos/v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; view_count: number; channel_name: string };
    expect(body.id).toBe('v1');
    expect(body.channel_name).toBe('alice');
    expect(body.view_count).toBe(1);

    const row = await env.DB.prepare('SELECT view_count FROM videos WHERE id = ?')
      .bind('v1')
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(1);

    const viewRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM views WHERE video_id = ?')
      .bind('v1')
      .first<{ n: number }>();
    expect(viewRows?.n).toBe(1);
  });

  it('does not double-count a repeat view from the same anonymous session', async () => {
    await seedUser('alice');
    await seedVideo({ id: 'v1', userId: 'alice', viewCount: 0 });

    const first = await SELF.fetch('http://t/api/videos/v1');
    expect(first.status).toBe(200);
    // ensureSessionId issues a fresh sid + Set-Cookie when none is present.
    const setCookie = first.headers.get('Set-Cookie') ?? '';
    const sidMatch = setCookie.match(/spool_view_sid=([^;]+)/);
    expect(sidMatch).not.toBeNull();
    const cookie = `spool_view_sid=${sidMatch![1]}`;

    const second = await SELF.fetch('http://t/api/videos/v1', {
      headers: { cookie },
    });
    expect(second.status).toBe(200);

    // Persisted state is the source of truth for dedup — only one views row
    // and one DB increment, regardless of how many times the same anon
    // session re-requests the page.
    const row = await env.DB.prepare('SELECT view_count FROM videos WHERE id = ?')
      .bind('v1')
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(1);
    const viewRows = await env.DB.prepare('SELECT COUNT(*) AS n FROM views WHERE video_id = ?')
      .bind('v1')
      .first<{ n: number }>();
    expect(viewRows?.n).toBe(1);
  });
});

describe('GET /api/videos/trending', () => {
  it('serves from cache on the second hit', async () => {
    await seedUser('alice');
    await seedVideo({ id: 'v1', userId: 'alice' });
    await seedVideo({ id: 'v2', userId: 'alice' });

    const first = await SELF.fetch('http://t/api/videos/trending?limit=5');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { cached: boolean; videos: unknown[] };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.videos.length).toBe(2);

    const second = await SELF.fetch('http://t/api/videos/trending?limit=5');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { cached: boolean; videos: unknown[] };
    expect(secondBody.cached).toBe(true);
    expect(secondBody.videos.length).toBe(2);
  });
});

describe('POST /api/videos/upload', () => {
  function buildForm(opts: {
    title?: string;
    file?: Blob;
    fileName?: string;
    chunkIndex?: string;
    chunkCount?: string;
  }): FormData {
    const fd = new FormData();
    fd.set('title', opts.title ?? 'integration test');
    fd.set('description', 'desc');
    if (opts.file !== undefined) {
      fd.set('file', opts.file, opts.fileName ?? 'clip.mp4');
    }
    fd.set('chunkIndex', opts.chunkIndex ?? '0');
    fd.set('chunkCount', opts.chunkCount ?? '1');
    return fd;
  }

  it('returns 401 when no session is attached', async () => {
    const fd = buildForm({
      file: new Blob([new Uint8Array(8)], { type: 'video/mp4' }),
    });
    const res = await SELF.fetch('http://t/api/videos/upload', {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(401);
  });

  it('rejects unsupported MIME types with 400', async () => {
    await seedUser('alice');
    const fd = buildForm({
      // .mp4 extension passes the extension allow-list, but text/plain isn't
      // an accepted MIME — `validateInitialFile` returns mime_not_allowed.
      file: new Blob([new Uint8Array(8)], { type: 'text/plain' }),
      fileName: 'clip.mp4',
    });
    const res = await SELF.fetch('http://t/api/videos/upload', {
      method: 'POST',
      body: fd,
      headers: { 'x-test-user-id': 'alice' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('mime_not_allowed');
  });

  it('returns 201 + queues the encode on a single-chunk happy path', async () => {
    await seedUser('alice');
    const blob = new Blob([new Uint8Array(16)], { type: 'video/mp4' });
    const fd = buildForm({ file: blob });

    const res = await SELF.fetch('http://t/api/videos/upload', {
      method: 'POST',
      body: fd,
      headers: { 'x-test-user-id': 'alice' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('queued');

    const row = await env.DB.prepare(
      'SELECT id, user_id, status, bytes FROM videos WHERE id = ?',
    )
      .bind(body.id)
      .first<{ id: string; user_id: string; status: string; bytes: number }>();
    expect(row).not.toBeNull();
    expect(row?.user_id).toBe('alice');
    expect(row?.status).toBe('queued');
    expect(row?.bytes).toBe(16);

    // R2 received the bytes under the expected key shape.
    const objects = await env.VIDEOS.list();
    expect(objects.objects.length).toBe(1);
    expect(objects.objects[0].key.startsWith('alice/')).toBe(true);
    expect(objects.objects[0].key.endsWith('clip.mp4')).toBe(true);
  });
});
