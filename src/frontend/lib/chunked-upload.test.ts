import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { uploadInChunks, CHUNK_SIZE, type UploadTarget } from './chunked-upload';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Provide a no-op localStorage stub so tests run in happy-dom.
const ssMap = new Map<string, string>();
beforeEach(() => ssMap.clear());
vi.stubGlobal('localStorage', {
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

  it('persists uploadId to localStorage after chunk 0 and clears on completion', async () => {
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
    // localStorage should be cleared after successful upload
    const stored = ssMap.get(`chunk-upload:big.mp4:${file.size}:${file.lastModified}`);
    expect(stored).toBeUndefined();
  });

  it('reports pre-existing progress fraction when resuming via localStorage', async () => {
    const file = makeFile(30 * 1024 * 1024, 'resume.mp4', 'video/mp4'); // 3 chunks
    const key = `chunk-upload:resume.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 2, chunkCount: 3 }));

    const chunks: number[] = [];
    mockFetch(async (_url, init) => {
      if (!init?.body) {
        return new Response(JSON.stringify({
          status: 'uploading',
          chunkCount: 3,
          uploadedChunks: [0, 1],
        }), { status: 200 });
      }
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

  it('uses server-reported chunks rather than stale local nextChunk when resuming', async () => {
    const file = makeFile(30 * 1024 * 1024, 'server-state.mp4', 'video/mp4');
    const key = `chunk-upload:server-state.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 2, chunkCount: 3 }));

    const chunks: number[] = [];
    mockFetch(async (_url, init) => {
      if (!init?.body) {
        return new Response(JSON.stringify({
          status: 'uploading',
          chunkCount: 3,
          uploadedChunks: [0],
        }), { status: 200 });
      }
      const fd = init.body as FormData;
      chunks.push(Number(fd.get('chunkIndex')));
      return new Response(JSON.stringify(
        chunks.length === 1 ? { uploadId: 'stored-id' } : { id: 'v1' },
      ), { status: chunks.length === 1 ? 202 : 201 });
    });

    await uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(chunks).toEqual([1, 2]);
  });

  it('restarts when the stored upload does not match the server chunk layout', async () => {
    const file = makeFile(30 * 1024 * 1024, 'layout-mismatch.mp4', 'video/mp4');
    const key = `chunk-upload:layout-mismatch.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 1, chunkCount: 3 }));

    const chunks: Array<{ chunkIndex: number; uploadId: string | null }> = [];
    mockFetch(async (_url, init) => {
      if (!init?.body) {
        return new Response(JSON.stringify({
          status: 'uploading',
          chunkCount: 2,
          uploadedChunks: [0],
        }), { status: 200 });
      }
      const fd = init.body as FormData;
      chunks.push({
        chunkIndex: Number(fd.get('chunkIndex')),
        uploadId: (fd.get('uploadId') as string | null) ?? null,
      });
      return new Response(JSON.stringify(chunks.length === 3 ? { id: 'v1' } : { uploadId: 'new-id' }), {
        status: chunks.length === 3 ? 201 : 202,
      });
    });

    await uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(chunks).toEqual([
      { chunkIndex: 0, uploadId: null },
      { chunkIndex: 1, uploadId: 'new-id' },
      { chunkIndex: 2, uploadId: 'new-id' },
    ]);
  });

  it('forwards custom headers to the resume status request', async () => {
    const file = makeFile(30 * 1024 * 1024, 'headers.mp4', 'video/mp4');
    const key = `chunk-upload:headers.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 1, chunkCount: 3 }));

    const seenHeaders: HeadersInit[] = [];
    mockFetch(async (_url, init) => {
      if (!init?.body) {
        seenHeaders.push(init?.headers ?? {});
        return new Response(JSON.stringify({
          status: 'uploading',
          chunkCount: 3,
          uploadedChunks: [0, 1],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'v1' }), { status: 201 });
    });

    await uploadInChunks({
      file,
      endpoint: '/api/upload',
      target: 'video',
      fields: {},
      headers: { authorization: 'Bearer token' },
      onProgress: () => {},
      _sleep: noSleep,
    });
    expect(seenHeaders).toEqual([{ authorization: 'Bearer token' }]);
  });

  it('keeps stored progress on transient resume status failures', async () => {
    const file = makeFile(30 * 1024 * 1024, 'status-err.mp4', 'video/mp4');
    const key = `chunk-upload:status-err.mp4:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'stored-id', nextChunk: 1, chunkCount: 3 }));

    const chunks: number[] = [];
    mockFetch(async (_url, init) => {
      if (!init?.body) return new Response('temporary', { status: 503 });
      const fd = init.body as FormData;
      chunks.push(Number(fd.get('chunkIndex')));
      return new Response(JSON.stringify(chunks.length === 2 ? { id: 'v1' } : { uploadId: 'stored-id' }), {
        status: chunks.length === 2 ? 201 : 202,
      });
    });

    await uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    });
    expect(chunks).toEqual([1, 2]);
  });

  it('retains stored progress when status lookup and upload retry fail transiently', async () => {
    const file = makeFile(30 * 1024 * 1024, 'status-err-fail.mp4', 'video/mp4');
    const key = `chunk-upload:status-err-fail.mp4:${file.size}:${file.lastModified}`;
    const stored = JSON.stringify({ uploadId: 'stored-id', nextChunk: 1, chunkCount: 3 });
    ssMap.set(key, stored);

    mockFetch(async (_url, init) => {
      if (!init?.body) return new Response('temporary', { status: 503 });
      return new Response('server down', { status: 503 });
    });

    await expect(uploadInChunks({
      file, endpoint: '/api/upload', target: 'video', fields: {}, onProgress: () => {},
      _sleep: noSleep,
    })).rejects.toThrow(/chunk 1 failed: 503/);
    expect(ssMap.get(key)).toBe(stored);
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

  it('does not call the video status endpoint when resuming recorder uploads', async () => {
    const file = makeFile(30 * 1024 * 1024, 'recording.webm', 'video/webm');
    const key = `chunk-upload:recording.webm:${file.size}:${file.lastModified}`;
    ssMap.set(key, JSON.stringify({ uploadId: 'rec-id', nextChunk: 1, chunkCount: 3 }));

    const calls: Array<{ method: string; hasBody: boolean; chunkIndex: number | null }> = [];
    mockFetch(async (_url, init) => {
      const fd = init?.body as FormData;
      calls.push({
        method: init?.method ?? 'GET',
        hasBody: Boolean(init?.body),
        chunkIndex: fd ? Number(fd.get('chunkIndex')) : null,
      });
      return new Response(JSON.stringify(
        calls.length === 2 ? { ok: true } : { uploadId: 'rec-id' },
      ), { status: calls.length === 2 ? 200 : 202 });
    });

    await uploadInChunks({
      file,
      endpoint: '/api/videos/upload',
      target: 'recorder',
      fields: { sessionId: 's1', takeId: 't1' },
      onProgress: () => {},
      _sleep: noSleep,
    });
    expect(calls).toEqual([
      { method: 'POST', hasBody: true, chunkIndex: 1 },
      { method: 'POST', hasBody: true, chunkIndex: 2 },
    ]);
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
