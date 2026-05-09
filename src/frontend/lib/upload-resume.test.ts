import { describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  cancelUpload,
  classifyChunkResponse,
  chunkCountFor,
  clearResumeRecord,
  fetchUploadStatus,
  fingerprintFile,
  fingerprintsMatch,
  loadResumeRecord,
  RESUME_RECORD_TTL_MS,
  saveResumeRecord,
  uploadFileInChunks,
  type FileSlice,
  type ResumeRecord,
} from './upload-resume';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function syntheticFile(size: number, name = 'clip.mp4', type = 'video/mp4'): FileSlice {
  return {
    size,
    type,
    name,
    slice(start: number, end: number) {
      const len = Math.max(0, end - start);
      return new Blob([new Uint8Array(len)], { type });
    },
  };
}

describe('chunkCountFor', () => {
  it('returns 1 for empty/zero-sized files', () => {
    expect(chunkCountFor(0)).toBe(1);
  });

  it('rounds up to the next chunk', () => {
    expect(chunkCountFor(1, 10)).toBe(1);
    expect(chunkCountFor(10, 10)).toBe(1);
    expect(chunkCountFor(11, 10)).toBe(2);
    expect(chunkCountFor(25, 10)).toBe(3);
  });
});

describe('classifyChunkResponse', () => {
  it('treats network errors and 5xx as retryable', () => {
    expect(classifyChunkResponse(0)).toBe('retry');
    expect(classifyChunkResponse(500)).toBe('retry');
    expect(classifyChunkResponse(503)).toBe('retry');
  });

  it('treats 408 / 429 as retryable', () => {
    expect(classifyChunkResponse(408)).toBe('retry');
    expect(classifyChunkResponse(429)).toBe('retry');
  });

  it('treats 4xx (other than 408/429) as fatal — re-uploading wont fix a 400', () => {
    expect(classifyChunkResponse(400)).toBe('fail');
    expect(classifyChunkResponse(401)).toBe('fail');
    expect(classifyChunkResponse(403)).toBe('fail');
    expect(classifyChunkResponse(413)).toBe('fail');
  });

  it('2xx is not classified as retry (caller short-circuits before reaching here)', () => {
    expect(classifyChunkResponse(200)).toBe('fail');
  });
});

describe('backoffMs', () => {
  it('caps exponentially with jitter', () => {
    const max = 10_000;
    for (let i = 0; i < 8; i += 1) {
      const v = backoffMs(i, 100, max);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(max);
    }
  });
});

describe('fingerprint', () => {
  it('matches identical fingerprints', () => {
    const a = fingerprintFile({ name: 'a.mp4', size: 10, lastModified: 5 } as File);
    const b = fingerprintFile({ name: 'a.mp4', size: 10, lastModified: 5 } as File);
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it('rejects when lastModified differs', () => {
    const a = fingerprintFile({ name: 'a.mp4', size: 10, lastModified: 5 } as File);
    const b = fingerprintFile({ name: 'a.mp4', size: 10, lastModified: 6 } as File);
    expect(fingerprintsMatch(a, b)).toBe(false);
  });
});

describe('resume record persistence', () => {
  function recordAt(t: number): ResumeRecord {
    return {
      uploadId: 'up-1',
      chunkCount: 5,
      title: 'hi',
      description: '',
      fingerprint: { name: 'a.mp4', size: 100, lastModified: 1 },
      createdAt: t,
    };
  }

  it('round-trips a fresh record', () => {
    const storage = new MemoryStorage();
    saveResumeRecord(recordAt(1000), storage);
    const loaded = loadResumeRecord(storage, 1500);
    expect(loaded?.uploadId).toBe('up-1');
    expect(loaded?.chunkCount).toBe(5);
  });

  it('returns null when stored record is older than TTL', () => {
    const storage = new MemoryStorage();
    saveResumeRecord(recordAt(0), storage);
    const loaded = loadResumeRecord(storage, RESUME_RECORD_TTL_MS + 1);
    expect(loaded).toBeNull();
  });

  it('clearResumeRecord removes the entry', () => {
    const storage = new MemoryStorage();
    saveResumeRecord(recordAt(0), storage);
    clearResumeRecord(storage);
    expect(loadResumeRecord(storage, 0)).toBeNull();
  });

  it('returns null when stored payload is malformed', () => {
    const storage = new MemoryStorage();
    storage.setItem('spooool.upload.resume.v1', '{not-json');
    expect(loadResumeRecord(storage, 0)).toBeNull();
  });

  it('returns null when stored payload is missing required fields', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'spooool.upload.resume.v1',
      JSON.stringify({ uploadId: 'x' }),
    );
    expect(loadResumeRecord(storage, 0)).toBeNull();
  });
});

describe('uploadFileInChunks', () => {
  it('uploads each chunk in order, captures uploadId, reports progress', async () => {
    const calls: Array<{ chunkIndex: string; uploadId: string | null }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      const fd = (init as RequestInit).body as FormData;
      const chunkIndex = fd.get('chunkIndex') as string;
      const uploadIdSent = fd.get('uploadId') as string | null;
      calls.push({ chunkIndex, uploadId: uploadIdSent });
      const total = Number(fd.get('chunkCount'));
      const idx = Number(chunkIndex);
      if (idx === 0) {
        return new Response(
          JSON.stringify({ status: 'chunk_received', chunkIndex: 0, chunkCount: total, uploadId: 'up-server' }),
          { status: 202 },
        );
      }
      if (idx === total - 1) {
        return new Response(JSON.stringify({ id: 'video-final', status: 'queued' }), {
          status: 201,
        });
      }
      return new Response(
        JSON.stringify({ status: 'chunk_received', chunkIndex: idx, chunkCount: total }),
        { status: 202 },
      );
    }) as unknown as typeof fetch;

    const progressFractions: number[] = [];
    const statuses: string[] = [];
    let captured: string | null = null;
    const result = await uploadFileInChunks(
      syntheticFile(25),
      { title: 't', description: '' },
      {
        fetchImpl,
        chunkSize: 10,
        delay: async () => {},
      },
      {
        onProgress: (p) => progressFractions.push(p.fraction),
        onStatus: (s) => statuses.push(s),
        onUploadId: (id) => {
          captured = id;
        },
      },
    );

    expect(result).toEqual({ videoId: 'video-final', status: 'queued' });
    expect(calls.map((c) => c.chunkIndex)).toEqual(['0', '1', '2']);
    expect(calls[0].uploadId).toBeNull();
    expect(calls[1].uploadId).toBe('up-server');
    expect(captured).toBe('up-server');
    // Initial 0/3, then 1/3, 2/3, 3/3.
    expect(progressFractions[0]).toBe(0);
    expect(progressFractions[progressFractions.length - 1]).toBeCloseTo(1, 5);
    expect(statuses).toContain('uploading');
  });

  it('skips already-uploaded chunks via skipChunks (resume path)', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      const fd = (init as RequestInit).body as FormData;
      const idx = Number(fd.get('chunkIndex'));
      const total = Number(fd.get('chunkCount'));
      calls.push(String(idx));
      if (idx === total - 1) {
        return new Response(JSON.stringify({ id: 'v-resumed', status: 'queued' }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify({ status: 'chunk_received' }), { status: 202 });
    }) as unknown as typeof fetch;

    const result = await uploadFileInChunks(
      syntheticFile(25),
      { title: 't', description: '' },
      {
        fetchImpl,
        chunkSize: 10,
        delay: async () => {},
        uploadId: 'up-resume',
        skipChunks: new Set([0, 1]),
      },
    );

    expect(calls).toEqual(['2']);
    expect(result.videoId).toBe('v-resumed');
  });

  it('retries a chunk on 503 with backoff, then succeeds', async () => {
    let count = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      count += 1;
      if (count <= 2) {
        return new Response('{"error":"unavailable"}', { status: 503 });
      }
      return new Response(JSON.stringify({ id: 'v-ok', status: 'queued' }), { status: 201 });
    }) as unknown as typeof fetch;

    const delays: number[] = [];
    const result = await uploadFileInChunks(
      syntheticFile(5),
      { title: 't', description: '' },
      {
        fetchImpl,
        chunkSize: 10,
        delay: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result.videoId).toBe('v-ok');
    expect(count).toBe(3);
    expect(delays.length).toBe(2); // 2 retries between 3 attempts
  });

  it('retries network errors (fetch throws) as transient', async () => {
    let count = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      count += 1;
      if (count === 1) throw new TypeError('Network error');
      return new Response(JSON.stringify({ id: 'v-net', status: 'queued' }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await uploadFileInChunks(
      syntheticFile(5),
      { title: 't', description: '' },
      {
        fetchImpl,
        chunkSize: 10,
        delay: async () => {},
      },
    );

    expect(result.videoId).toBe('v-net');
    expect(count).toBe(2);
  });

  it('stops retrying after maxRetries on persistent 5xx', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response('{"error":"down"}', { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      uploadFileInChunks(
        syntheticFile(5),
        { title: 't', description: '' },
        {
          fetchImpl,
          chunkSize: 10,
          delay: async () => {},
          maxRetries: 2,
        },
      ),
    ).rejects.toThrow(/Upload failed \(503\)/);

    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry a 4xx — those are deterministic', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'Storage quota exceeded.', code: 'storage_quota_exceeded' }),
          { status: 413 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      uploadFileInChunks(
        syntheticFile(5),
        { title: 't', description: '' },
        { fetchImpl, chunkSize: 10, delay: async () => {} },
      ),
    ).rejects.toThrow(/Storage quota exceeded/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits for online before retrying when offline', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 'v', status: 'queued' }), { status: 201 }),
    ) as unknown as typeof fetch;

    let nowOffline = true;
    let resolveOnline = (): void => {};
    const waitForOnlinePromise = new Promise<void>((resolve) => {
      resolveOnline = () => {
        nowOffline = false;
        resolve();
      };
    });

    const statuses: string[] = [];
    const promise = uploadFileInChunks(
      syntheticFile(5),
      { title: 't', description: '' },
      {
        fetchImpl,
        chunkSize: 10,
        delay: async () => {},
        isOffline: () => nowOffline,
        waitForOnline: () => waitForOnlinePromise,
      },
      {
        onStatus: (s) => statuses.push(s),
      },
    );

    // Allow the upload to enter the offline-wait branch.
    await new Promise((r) => setTimeout(r, 5));
    expect(statuses).toContain('offline');
    expect(fetchImpl).not.toHaveBeenCalled();

    resolveOnline();
    const result = await promise;
    expect(result.videoId).toBe('v');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws UploadAbortedError when signal is aborted before next chunk', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({ status: 'chunk_received', uploadId: 'x' }), {
        status: 202,
      });
    }) as unknown as typeof fetch;

    await expect(
      uploadFileInChunks(
        syntheticFile(15),
        { title: 't', description: '' },
        {
          fetchImpl,
          chunkSize: 10,
          delay: async () => {},
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/Upload aborted/);
  });
});

describe('fetchUploadStatus', () => {
  it('returns the parsed body on 200', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            uploadId: 'up-1',
            chunkCount: 4,
            uploadedChunks: [0, 1],
            fileName: 'clip.mp4',
            fileSize: 100,
            title: 'hi',
            description: '',
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const result = await fetchUploadStatus('up-1', fetchImpl);
    expect(result?.uploadedChunks).toEqual([0, 1]);
  });

  it('returns null on 404 (session expired or never existed)', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response('{}', { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchUploadStatus('up-1', fetchImpl)).toBeNull();
  });

  it('throws on other non-2xx responses', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response('oops', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchUploadStatus('up-1', fetchImpl)).rejects.toThrow();
  });
});

describe('cancelUpload', () => {
  it('issues DELETE to the upload endpoint', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: (init as RequestInit).method ?? 'GET' });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await cancelUpload('up xy', fetchImpl);
    expect(calls).toEqual([
      { url: '/api/videos/upload/up%20xy', method: 'DELETE' },
    ]);
  });

  it('swallows network errors so cancel is best-effort', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(cancelUpload('up-1', fetchImpl)).resolves.toBeUndefined();
  });
});
