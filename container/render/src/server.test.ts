import { describe, expect, it, vi } from 'vitest';
import { createServer } from './server';

const noopRender = vi.fn(async () => ({ outputPath: '/tmp/out.mp4' }));
const noopUpload = vi.fn(async () => 'recorder/renders/j_x.mp4');
const noopCallback = vi.fn(async () => {});
const noopEncode = vi.fn(async () => ({ masterKey: 'hls/v/master.m3u8', thumbnailKey: null as string | null }));

function buildApp(deps?: Partial<Parameters<typeof createServer>[0]>) {
  return createServer({
    renderJob: noopRender,
    uploadToR2: noopUpload,
    encodeToHls: noopEncode,
    callbackToWorker: noopCallback,
    queueMax: 3,
    ...deps,
  });
}

describe('container HTTP server', () => {
  it('GET /health returns ok', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /render rejects when jobId is missing', async () => {
    const app = buildApp();
    const res = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /render accepts a job, returns 200, and processes asynchronously', async () => {
    noopRender.mockClear(); noopUpload.mockClear(); noopCallback.mockClear();
    const app = buildApp();
    const res = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'j_1', takeKeys: ['k'], compositionProps: { title: 't' } }),
    });
    expect(res.status).toBe(200);
    // Render runs after accept; wait briefly
    await new Promise((r) => setTimeout(r, 30));
    expect(noopRender).toHaveBeenCalledTimes(1);
    expect(noopUpload).toHaveBeenCalledTimes(1);
    // callbackToWorker is called at start (progress 0), then complete
    expect(noopCallback).toHaveBeenCalled();
    const calls = noopCallback.mock.calls.map((c) => c[0]);
    expect(calls).toContain('/api/render/jobs/j_1/progress');
    expect(calls).toContain('/api/render/jobs/j_1/complete');
  });

  it('POST /render returns 429 when queue is full', async () => {
    // Stub a slow render so the first job sits in the drain loop while we hit the limit
    const slowRender = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { outputPath: '/tmp/slow.mp4' };
    });
    const app = createServer({
      renderJob: slowRender,
      uploadToR2: noopUpload,
      callbackToWorker: noopCallback,
      queueMax: 1,
    });
    const r1 = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'a', takeKeys: ['k'], compositionProps: {} }),
    });
    // Don't await drain — immediately attempt second
    const r2 = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'b', takeKeys: ['k'], compositionProps: {} }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });

  it('POST /render reports failure to worker /fail when render throws', async () => {
    const failingRender = vi.fn(async () => { throw new Error('boom'); });
    const failCallback = vi.fn(async () => {});
    const app = createServer({
      renderJob: failingRender,
      uploadToR2: noopUpload,
      callbackToWorker: failCallback,
      queueMax: 3,
    });
    const res = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'j_fail', takeKeys: ['k'], compositionProps: {} }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    // Should have called /fail with the boom message
    const failCalls = failCallback.mock.calls.filter((c) => c[0] === '/api/render/jobs/j_fail/fail');
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][1]).toMatchObject({ error: 'boom' });
  });

  it('POST /encode rejects when videoId or r2Key is missing', async () => {
    const app = buildApp();
    const r1 = await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ r2Key: 'user/vid/file.mp4' }),
    });
    expect(r1.status).toBe(400);

    const r2 = await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid-1' }),
    });
    expect(r2.status).toBe(400);
  });

  it('POST /encode accepts a job, returns 200, and calls encodeToHls then complete callback', async () => {
    const noopEncode = vi.fn(async () => ({ masterKey: 'hls/vid-2/master.m3u8', thumbnailKey: null }));
    const cb = vi.fn(async () => {});
    const app = createServer({
      renderJob: noopRender,
      uploadToR2: noopUpload,
      encodeToHls: noopEncode,
      callbackToWorker: cb,
      queueMax: 3,
    });
    const res = await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid-2', r2Key: 'user/vid-2/file.mp4' }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(noopEncode).toHaveBeenCalledWith({ videoId: 'vid-2', r2Key: 'user/vid-2/file.mp4' });
    const completeCalls = cb.mock.calls.filter((c) => (c[0] as string).includes('/complete'));
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0][0]).toBe('/api/webhooks/encode/vid-2/complete');
    expect(completeCalls[0][1]).toMatchObject({ masterKey: 'hls/vid-2/master.m3u8' });
  });

  it('POST /encode returns 429 when encode queue is full', async () => {
    const slowEncode = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { masterKey: 'hls/v/master.m3u8', thumbnailKey: null };
    });
    const app = createServer({
      renderJob: noopRender,
      uploadToR2: noopUpload,
      encodeToHls: slowEncode,
      callbackToWorker: noopCallback,
      queueMax: 1,
    });
    await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'v1', r2Key: 'k1' }),
    });
    const r2 = await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'v2', r2Key: 'k2' }),
    });
    expect(r2.status).toBe(429);
  });

  it('POST /encode calls /fail callback when encodeToHls throws', async () => {
    const failEncode = vi.fn(async () => { throw new Error('ffmpeg crash'); });
    const cb = vi.fn(async () => {});
    const app = createServer({
      renderJob: noopRender,
      uploadToR2: noopUpload,
      encodeToHls: failEncode,
      callbackToWorker: cb,
      queueMax: 3,
    });
    await app.request('/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'vid-err', r2Key: 'user/vid-err/file.mp4' }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const failCalls = cb.mock.calls.filter((c) => (c[0] as string).includes('/fail'));
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][0]).toBe('/api/webhooks/encode/vid-err/fail');
    expect(failCalls[0][1]).toMatchObject({ error: 'ffmpeg crash' });
  });
});
