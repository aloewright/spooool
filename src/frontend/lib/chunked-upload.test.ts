import { describe, expect, it, vi, afterEach } from 'vitest';
import { uploadInChunks, type UploadTarget } from './chunked-upload';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

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
    });
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('throws when a chunk POST returns non-2xx', async () => {
    mockFetch(async () => new Response('{"error":"oops"}', { status: 500 }));
    const file = makeFile(5 * 1024 * 1024);
    await expect(uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
    })).rejects.toThrow(/^chunk 0 failed: 500/);
  });
});
