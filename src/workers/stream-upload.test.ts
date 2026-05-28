import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { streamUploadRoutes, type StreamUploadEnv } from './stream-upload';

type SessionUser = { id: string; emailVerified: boolean } | null;

function stubStream(impl?: (input: Record<string, unknown>) => Promise<unknown> | unknown) {
  const calls: Array<{ input: Record<string, unknown> }> = [];
  const binding = {
    async createDirectUpload(input: Record<string, unknown>) {
      calls.push({ input });
      if (impl) return impl(input);
      return { uid: 'stream_uid_123', uploadURL: 'https://upload.videodelivery.net/stream_uid_123' };
    },
  };
  (binding as unknown as { _calls: typeof calls })._calls = calls;
  return binding as unknown as StreamUploadEnv['STREAM'];
}

function envFor(extra: Partial<StreamUploadEnv> = {}): StreamUploadEnv {
  return {
    STREAM: stubStream(),
    RATE_LIMITER: undefined,
    ...extra,
  };
}

function buildApp(user: SessionUser, extra: Partial<StreamUploadEnv> = {}) {
  const app = new Hono<{ Bindings: StreamUploadEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', streamUploadRoutes);
  return { app, env: envFor(extra) };
}

describe('POST /api/stream/upload-url', () => {
  it('mints a direct upload URL with creator, meta, allowedOrigins, and maxDurationSeconds applied', async () => {
    const stream = stubStream();
    const { app, env } = buildApp({ id: 'u_42', emailVerified: true }, { STREAM: stream });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSeconds: 600, meta: { recording_session: 'sess_abc' } }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { uid: string; uploadURL: string; customerHost: string };
    expect(body.uid).toBe('stream_uid_123');
    expect(body.uploadURL).toBe('https://upload.videodelivery.net/stream_uid_123');
    expect(body.customerHost).toMatch(/^customer-/);
    const calls = (stream as unknown as { _calls: Array<{ input: Record<string, unknown> }> })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      maxDurationSeconds: 600,
      creator: 'u_42',
      requireSignedURLs: false,
      allowedOrigins: expect.arrayContaining(['spooool.com']),
    });
    expect(calls[0].input.meta).toMatchObject({
      recording_session: 'sess_abc',
      spooool_user_id: 'u_42',
      spooool_source: 'direct_upload',
    });
  });

  it('defaults maxDurationSeconds when omitted', async () => {
    const stream = stubStream();
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { STREAM: stream });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(200);
    const calls = (stream as unknown as { _calls: Array<{ input: Record<string, unknown> }> })._calls;
    expect(calls[0].input.maxDurationSeconds).toBe(60 * 30);
  });

  it('401s without a session', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('403s when emailVerified is false', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: false });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rejects maxDurationSeconds above the cap', async () => {
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSeconds: 99999 }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('502s when the Stream binding throws', async () => {
    const stream = stubStream(() => { throw new Error('Stream API 503'); });
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { STREAM: stream });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(res.status).toBe(502);
  });

  it('passes through requireSignedURLs', async () => {
    const stream = stubStream();
    const { app, env } = buildApp({ id: 'u_1', emailVerified: true }, { STREAM: stream });
    const res = await app.request(
      '/api/stream/upload-url',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requireSignedURLs: true }) },
      env,
    );
    expect(res.status).toBe(200);
    const calls = (stream as unknown as { _calls: Array<{ input: { requireSignedURLs?: boolean } }> })._calls;
    expect(calls[0].input.requireSignedURLs).toBe(true);
  });
});
