import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { uploadInChunks, CHUNK_SIZE, type UploadTarget } from './chunked-upload';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Provide a no-op sessionStorage stub so tests run in happy-dom.
const ssMap = new Map<string, string>();
beforeEach(() => ssMap.clear());
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => ssMap.get(k) ?? null,
  setItem: (k: string, v: string) => ssMap.set(k, v),
  removeItem: (k: string) => ssMap.delete(k),
});

const noSleep = async () => {};

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

function makeFile(bytes: number, name = 'clip.webm', type = 'video/webm'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('uploadInChunks', () => {
  it('posts every chunk to the configured endpoint and threads uploadId across calls', async () => {
    const calls: Array<{ formChunkIndex: string; uploadId: string | null }> = [];
    mockFetch(async (_url, init) => {
      const fd = init?.body as FormData;
      const idx = fd.get('chunkIndex') as string;
      calls.push({ formChunkIndex: idx, uploadId: (fd.get('uploadId') as string) ?? null });
      return new Response(JSON.stringify({ uploadId: 'u_1' }), { status: 200 });
    });
    const file = makeFile(25 * 1024 * 1024); // 3 chunks at 10MB each
    const res = await uploadInChunks({
      file,
      endpoint: '/api/videos/upload',
      target: 'video' as UploadTarget,
      fields: { title: 'hi', description: '' },
      onProgress: () => {},
      _sleep: noSleep,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].uploadId).toBeNull();
    expect(calls[1].uploadId).toBe('u_1');
    expect(calls[2].uploadId).toBe('u_1');
  });

  it('reports monotonic progress 0..1 across all chunks', async () => {
    mockFetch(async () => new Response(JSON.stringify({ uploadId: 'u' }), { status: 200 }));
    const file = makeFile(20 * 1024 * 1024);
    const seen: number[] = [];
    await uploadInChunks({
      file,
      endpoint: '/api/videos/upload',
      target: 'video',
      fields: {},
      onProgress: (v) => seen.push(v),
      _sleep: noSleep,
    });
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('throws on 4xx without retrying', async () => {
    const callCount = { n: 0 };
    mockFetch(async () => {
      callCount.n++;
      return new Response('{"error":"bad request"}', { status: 400 });
    });
    const file = makeFile(5 * 1024 * 1024);
    await expect(uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    })).rejects.toThrow(/^chunk 0 failed: 400/);
    // 4xx: no retry
    expect(callCount.n).toBe(1);
  });

  it('retries up to 3 times on 5xx then throws', async () => {
    const callCount = { n: 0 };
    mockFetch(async () => {
      callCount.n++;
      return new Response('err', { status: 500 });
    });
    const file = makeFile(5 * 1024 * 1024);
    await expect(uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    })).rejects.toThrow(/^chunk 0 failed: 500/);
    // 1 initial + 3 retries = 4 calls
    expect(callCount.n).toBe(4);
  });

  it('retries on network error and succeeds if server recovers', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount < 3) throw new Error('network error');
      return new Response(JSON.stringify({ id: 'vid-1' }), { status: 201 });
    });
    const file = makeFile(5 * 1024 * 1024);
    const result = await uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.videoId).toBe('vid-1');
    expect(callCount).toBe(3);
  });

  it('persists uploadId to sessionStorage after chunk 0 and clears on completion', async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      const body = call === 1 ? { uploadId: 'sess-1' } : { id: 'vid-abc' };
      const status = call < 3 ? 202 : 201;
      return new Response(JSON.stringify(body), { status });
    });
    const file = makeFile(25 * 1024 * 1024, 'big.mp4', 'video/mp4'); // 3 chunks
    const result = await uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(result.videoId).toBe('vid-abc');
    // sessionStorage should be cleared after successful upload
    const stored = ssMap.get(`chunk-upload:big.mp4:${file.size}:${file.lastModified}`);
    expect(stored).toBeUndefined();
  });

  it('reports pre-existing progress fraction when resuming via sessionStorage', async () => {
    const file = makeFile(30 * 1024 * 1024, 'resume.mp4', 'video/mp4'); // 3 chunks
    const key = `chunk-upload:resume.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 2, chunkCount: 3 }));

    const chunks: number[] = [];
    mockFetch(async (_url, init) => {
      const fd = init?.body as FormData;
      chunks.push(Number(fd.get('chunkIndex')));
      return new Response(JSON.stringify({ id: 'v1' }), { status: 201 });
    });

    const progressValues: number[] = [];
    await uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: (v) => progressValues.push(v),
      _sleep: noSleep,
    });
    // Only chunk 2 (index 2) should be sent — chunks 0 and 1 already uploaded
    expect(chunks).toEqual([2]);
    // First progress report is the resumed fraction (2/3)
    expect(progressValues[0]).toBeCloseTo(2 / 3);
    // Final progress should be 1
    expect(progressValues[progressValues.length - 1]).toBe(1);
  });

  it('extracts videoId from the final 201 response', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ id: 'video-xyz', status: 'queued' }), { status: 201 }),
    );
    const file = makeFile(1024);
    const result = await uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(result.videoId).toBe('video-xyz');
  });

  it('clears stored progress on 4xx so the next attempt starts fresh', async () => {
    const file = makeFile(25 * 1024 * 1024, 'bad.mp4', 'video/mp4');
    const key = `chunk-upload:bad.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'old-id', nextChunk: 1, chunkCount: 3 }));

    mockFetch(async () => new Response('quota exceeded', { status: 413 }));
    await expect(uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    })).rejects.toThrow();
    expect(ssMap.has(key)).toBe(false);
  });

  it('keeps stored progress on 5xx so the user can retry after server recovers', async () => {
    const file = makeFile(25 * 1024 * 1024, 'srv-err.mp4', 'video/mp4');
    const key = `chunk-upload:srv-err.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'keep-id', nextChunk: 1, chunkCount: 3 }));

    mockFetch(async () => new Response('server error', { status: 503 }));
    await expect(uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    })).rejects.toThrow();
    // Progress should be kept so the user can retry
    expect(ssMap.has(key)).toBe(true);
  });

  it('uses CHUNK_SIZE constant to split the file', () => {
    expect(CHUNK_SIZE).toBe(10 * 1024 * 1024);
  });
});
