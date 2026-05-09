import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildStreamSourceUrl, type EncodingEnv } from './encoding';
import { streamSourceRoutes, type StreamSourceEnv } from './stream-source';

interface FakeR2Object {
  bytes: Uint8Array;
  contentType: string;
}

function makeR2(seed: Record<string, FakeR2Object>): R2Bucket {
  return {
    async head(key: string) {
      const obj = seed[key];
      if (!obj) return null;
      return {
        size: obj.bytes.byteLength,
        httpMetadata: { contentType: obj.contentType },
      } as R2Object;
    },
    async get(key: string) {
      const obj = seed[key];
      if (!obj) return null;
      const buffer = new Uint8Array(obj.bytes).buffer;
      return {
        body: new Response(buffer).body,
        size: obj.bytes.byteLength,
        httpMetadata: { contentType: obj.contentType },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

const baseEnv = (videos: R2Bucket): StreamSourceEnv => ({
  DB: {} as D1Database,
  VIDEOS: videos,
  STREAM_ENABLED: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CF_STREAM_API_TOKEN: 'tok',
  STREAM_SOURCE_ORIGIN: 'https://spooool.test',
  CF_STREAM_WEBHOOK_SECRET: 'shh',
});

function buildApp() {
  const app = new Hono<{ Bindings: StreamSourceEnv }>();
  app.route('/', streamSourceRoutes);
  return app;
}

describe('GET /api/internal/stream-source', () => {
  it('serves the R2 object when the signature is valid', async () => {
    const videos = makeR2({
      'u/v/clip.mp4': { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'video/mp4' },
    });
    const env = baseEnv(videos);
    const url = await buildStreamSourceUrl(env as EncodingEnv, 'u/v/clip.mp4');
    const res = await buildApp().request(url, { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it('returns 200 with no body for HEAD', async () => {
    const videos = makeR2({
      'k': { bytes: new Uint8Array([0]), contentType: 'video/mp4' },
    });
    const env = baseEnv(videos);
    const url = await buildStreamSourceUrl(env as EncodingEnv, 'k');
    const res = await buildApp().request(url, { method: 'HEAD' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1');
  });

  it('rejects requests without a signature with 400', async () => {
    const env = baseEnv(makeR2({}));
    const res = await buildApp().request(
      '/api/internal/stream-source?key=k',
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a tampered signature with 403', async () => {
    const videos = makeR2({ k: { bytes: new Uint8Array([1]), contentType: 'video/mp4' } });
    const env = baseEnv(videos);
    const url = new URL(await buildStreamSourceUrl(env as EncodingEnv, 'k'));
    url.searchParams.set('sig', 'a'.repeat(64));
    const res = await buildApp().request(url.toString(), { method: 'GET' }, env);
    expect(res.status).toBe(403);
  });

  it('rejects an expired signature with 403', async () => {
    const videos = makeR2({ k: { bytes: new Uint8Array([1]), contentType: 'video/mp4' } });
    const env = baseEnv(videos);
    const past = 1_000;
    const url = new URL(await buildStreamSourceUrl(env as EncodingEnv, 'k', past));
    const res = await buildApp().request(url.toString(), { method: 'GET' }, env);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the R2 object is missing', async () => {
    const env = baseEnv(makeR2({}));
    const url = await buildStreamSourceUrl(env as EncodingEnv, 'nope');
    const res = await buildApp().request(url, { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});
