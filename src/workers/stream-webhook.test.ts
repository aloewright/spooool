import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  handleStreamWebhook,
  mapStreamState,
  verifyWebhookSignature,
} from './stream-webhook';

const SECRET = 'test-secret-please-change';

async function signBody(body: string, time: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${time}.${body}`),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface FakeRow {
  id: string;
  stream_video_id: string;
  status: string;
  playback_hls_url: string | null;
  thumbnail_url: string | null;
  thumbnail_candidates: string | null;
  updated_at: number;
}

function makeFakeDB(seed: FakeRow[] = []): {
  rows: FakeRow[];
  binding: D1Database;
} {
  const rows = [...seed];
  const db = {
    prepare(_query: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async run() {
          // Bound order matches stream-webhook.ts:
          //   status, uid, playbackHls, thumbnail, candidates, whereUid, ...allowedFromStatuses
          const [status, uid, playbackHls, thumbnail, candidates, whereUid, ...allowedFrom] =
            bound as [string, string, string | null, string | null, string | null, string, ...string[]];
          const allowedSet = new Set(allowedFrom);
          let changes = 0;
          for (const row of rows) {
            if (row.stream_video_id === whereUid && allowedSet.has(row.status)) {
              row.status = status;
              row.stream_video_id = uid;
              if (playbackHls !== null) row.playback_hls_url = playbackHls;
              if (thumbnail !== null) row.thumbnail_url = thumbnail;
              if (candidates !== null) row.thumbnail_candidates = candidates;
              row.updated_at = Date.now();
              changes++;
            }
          }
          return { meta: { changes } };
        },
        // email notification path: SELECT by stream_video_id — return null so the
        // background send is a no-op in tests (no email bindings available).
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { rows, binding: db };
}

describe('mapStreamState', () => {
  it('maps ready → ready', () => {
    expect(mapStreamState('ready')).toBe('ready');
    expect(mapStreamState('READY')).toBe('ready');
  });
  it('maps error → failed', () => {
    expect(mapStreamState('error')).toBe('failed');
    expect(mapStreamState(' Error ')).toBe('failed');
  });
  it('maps any other state → encoding', () => {
    expect(mapStreamState('queued')).toBe('encoding');
    expect(mapStreamState('inprogress')).toBe('encoding');
    expect(mapStreamState('downloading')).toBe('encoding');
    expect(mapStreamState('pendingupload')).toBe('encoding');
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a fresh, well-signed payload', async () => {
    const body = '{"uid":"abc"}';
    const time = 1_700_000_000;
    const sig = await signBody(body, time, SECRET);
    const result = await verifyWebhookSignature(body, `time=${time},sig1=${sig}`, SECRET, time);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a missing header', async () => {
    const result = await verifyWebhookSignature('{}', null, SECRET);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a malformed header', async () => {
    const result = await verifyWebhookSignature('{}', 'garbage', SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('rejects a stale timestamp', async () => {
    const body = '{}';
    const time = 1_700_000_000;
    const sig = await signBody(body, time, SECRET);
    const result = await verifyWebhookSignature(
      body,
      `time=${time},sig1=${sig}`,
      SECRET,
      time + 60 * 60,
    );
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a wrong signature', async () => {
    const body = '{"uid":"abc"}';
    const time = 1_700_000_000;
    const sig = await signBody(body, time, 'other-secret');
    const result = await verifyWebhookSignature(body, `time=${time},sig1=${sig}`, SECRET, time);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

async function postWebhook(
  app: Hono<{ Bindings: { DB: D1Database; CF_STREAM_WEBHOOK_SECRET?: string } }>,
  env: { DB: D1Database; CF_STREAM_WEBHOOK_SECRET?: string },
  body: string,
  signatureTime: number,
  secret: string,
) {
  const sig = await signBody(body, signatureTime, secret);
  return app.request(
    '/api/webhooks/stream',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Webhook-Signature': `time=${signatureTime},sig1=${sig}`,
      },
      body,
    },
    env,
  );
}

function buildApp(now: number) {
  const app = new Hono<{ Bindings: { DB: D1Database; CF_STREAM_WEBHOOK_SECRET?: string } }>();
  app.post('/api/webhooks/stream', handleStreamWebhook({ now: () => now }));
  return app;
}

describe('handleStreamWebhook', () => {
  it('returns 503 when the secret is not configured', async () => {
    const app = buildApp(1);
    const { binding } = makeFakeDB();
    const res = await app.request('/api/webhooks/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, { DB: binding });
    expect(res.status).toBe(503);
  });

  it('rejects an invalid signature with 401', async () => {
    const app = buildApp(1_700_000_000);
    const { binding } = makeFakeDB();
    const res = await app.request('/api/webhooks/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Webhook-Signature': 'time=1700000000,sig1=deadbeef',
      },
      body: '{"uid":"abc"}',
    }, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET });
    expect(res.status).toBe(401);
  });

  it('updates the matching video to ready and stores playback + thumbnail', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'abc',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: 0,
      },
    ]);

    const body = JSON.stringify({
      uid: 'abc',
      status: { state: 'ready' },
      playback: { hls: 'https://videodelivery.net/abc/manifest/video.m3u8' },
      thumbnail: 'https://videodelivery.net/abc/thumbnails/thumbnail.jpg',
    });

    const res = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe('ready');
    expect(rows[0].playback_hls_url).toBe('https://videodelivery.net/abc/manifest/video.m3u8');
    expect(rows[0].thumbnail_url).toBe('https://videodelivery.net/abc/thumbnails/thumbnail.jpg');
  });

  it('maps error → failed', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'abc',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: 0,
      },
    ]);

    const body = JSON.stringify({ uid: 'abc', status: { state: 'error' } });
    const res = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe('failed');
  });

  it('maps in-progress states → encoding', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'abc',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: 0,
      },
    ]);

    const body = JSON.stringify({ uid: 'abc', status: { state: 'inprogress' } });
    const res = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe('encoding');
  });

  it('is idempotent — same payload twice does not change a second row', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'abc',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: 0,
      },
    ]);
    const body = JSON.stringify({
      uid: 'abc',
      status: { state: 'ready' },
      playback: { hls: 'https://videodelivery.net/abc/manifest/video.m3u8' },
      thumbnail: 'https://videodelivery.net/abc/thumbnails/thumbnail.jpg',
    });
    const first = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    const second = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows.filter((r) => r.status === 'ready')).toHaveLength(1);
    expect(rows[0].playback_hls_url).toBe('https://videodelivery.net/abc/manifest/video.m3u8');
  });

  it('returns 202 with matched=0 when no row owns the uid', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { binding } = makeFakeDB([]);
    const body = JSON.stringify({ uid: 'unknown', status: { state: 'ready' } });
    const res = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(res.status).toBe(202);
    const json = (await res.json()) as { matched: number };
    expect(json.matched).toBe(0);
  });

  // ALO-138: a stale `inprogress` webhook arriving after the row already
  // reached `ready` must not pull the lifecycle backwards.
  it('refuses to drag a ready row back to encoding', async () => {
    const time = 1_700_000_000;
    const app = buildApp(time);
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'abc',
        status: 'ready',
        playback_hls_url: 'https://videodelivery.net/abc/manifest/video.m3u8',
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: 0,
      },
    ]);

    const body = JSON.stringify({ uid: 'abc', status: { state: 'inprogress' } });
    const res = await postWebhook(app, { DB: binding, CF_STREAM_WEBHOOK_SECRET: SECRET }, body, time, SECRET);
    expect(res.status).toBe(202);
    const json = (await res.json()) as { matched: number };
    expect(json.matched).toBe(0);
    expect(rows[0].status).toBe('ready');
  });
});
