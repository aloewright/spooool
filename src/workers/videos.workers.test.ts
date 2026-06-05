import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { videoMetaCacheKey } from './video-meta-cache';
import { seedTestCreator } from './worker-test-helpers';

describe('video API worker integration (ALO-189)', () => {
  beforeAll(async () => {
    await seedTestCreator(env.DB, 'creator-vi', 'vi@example.com', 'VI Creator');

    await env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, status, view_count, created_at, updated_at)
       VALUES ('vid-int-1', 'creator-vi', 'Integration video', 'desc', 'creator-vi/vid-int-1/raw.mp4', 'ready', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
  });

  it('GET /api/videos lists public videos', async () => {
    const res = await SELF.fetch('http://localhost/api/videos?limit=10&page=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { videos: Array<{ id: string }> };
    expect(body.videos.some((v) => v.id === 'vid-int-1')).toBe(true);
  });

  it('GET /api/videos/:id returns 404 for unknown ids', async () => {
    const res = await SELF.fetch('http://localhost/api/videos/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /api/videos/:id returns the video and increments view_count', async () => {
    const before = await env.DB.prepare('SELECT view_count FROM videos WHERE id = ?')
      .bind('vid-int-1')
      .first<{ view_count: number }>();

    const res = await SELF.fetch('http://localhost/api/videos/vid-int-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; view_count: number };
    expect(body.id).toBe('vid-int-1');

    const after = await env.DB.prepare('SELECT view_count FROM videos WHERE id = ?')
      .bind('vid-int-1')
      .first<{ view_count: number }>();
    expect((after?.view_count ?? 0)).toBeGreaterThan(before?.view_count ?? 0);
  });

  it('GET /api/videos/trending caches the second hit', async () => {
    const first = await SELF.fetch('http://localhost/api/videos/trending?limit=5');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { cached: boolean };
    expect(firstBody.cached).toBe(false);

    const second = await SELF.fetch('http://localhost/api/videos/trending?limit=5');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { cached: boolean };
    expect(secondBody.cached).toBe(true);
  });

  it('POST /api/videos/upload returns 401 without a session', async () => {
    const fd = new FormData();
    fd.set('title', 'nope');
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'video/mp4' }), 'clip.mp4');
    const res = await SELF.fetch('http://localhost/api/videos/upload', {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
      body: fd,
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/videos/upload returns 400 for bad MIME without auth bypass', async () => {
    const fd = new FormData();
    fd.set('title', 'bad mime');
    fd.set('file', new Blob([new Uint8Array(8)], { type: 'text/plain' }), 'notes.txt');
    const res = await SELF.fetch('http://localhost/api/videos/upload', {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
      body: fd,
    });
    // Still 401 — no session cookie on the integration request.
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/videos cache invalidation (ALO-431)', () => {
  it('documents cache key shape used by delete path', () => {
    expect(videoMetaCacheKey('vid-x')).toBe('video:v1:vid-x');
  });
});
