import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { seedTestCreator, signStreamWebhookBody } from './worker-test-helpers';

const WEBHOOK_SECRET = 'vitest-webhook-secret';

describe('POST /api/webhooks/stream (worker integration, ALO-460)', () => {
  beforeAll(async () => {
    await seedTestCreator(env.DB, 'creator-wh', 'creator@example.com', 'Creator');

    await env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, status, stream_video_id, view_count, created_at, updated_at)
       VALUES ('vid-wh-1', 'creator-wh', 'Webhook test', '', 'creator-wh/vid-wh-1/raw.mp4', 'encoding', 'stream-uid-wh', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
  });

  it('returns 401 for requests without a valid signature', async () => {
    const res = await SELF.fetch('http://localhost/api/webhooks/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'stream-uid-wh', status: { state: 'ready' } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('missing_header');
  });

  it('accepts a valid signature and transitions encoding → ready in D1', async () => {
    const payload = JSON.stringify({
      uid: 'stream-uid-wh',
      status: { state: 'ready' },
      playback: { hls: 'https://example.com/playlist.m3u8' },
    });
    const sig = await signStreamWebhookBody(payload, WEBHOOK_SECRET);
    const res = await SELF.fetch('http://localhost/api/webhooks/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Webhook-Signature': sig,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matched: number; status: string };
    expect(body.ok).toBe(true);
    expect(body.matched).toBeGreaterThanOrEqual(1);
    expect(body.status).toBe('ready');

    const row = await env.DB.prepare('SELECT status FROM videos WHERE id = ?')
      .bind('vid-wh-1')
      .first<{ status: string }>();
    expect(row?.status).toBe('ready');
  });

  it('returns 400 for malformed JSON even with a valid signature', async () => {
    const body = '{not-json';
    const sig = await signStreamWebhookBody(body, WEBHOOK_SECRET);
    const res = await SELF.fetch('http://localhost/api/webhooks/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Webhook-Signature': sig,
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});
