import { describe, expect, it } from 'vitest';
import {
  chunkIndexForPartNumber,
  completedPartsForR2,
  deleteManifest,
  loadManifest,
  manifestKey,
  manifestProgress,
  partNumberForChunkIndex,
  saveManifest,
  totalBytesInManifest,
  uploadManifestSchema,
  type UploadManifest,
} from './chunked-upload';

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      const raw = store.get(key);
      return raw === undefined ? null : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function buildManifest(overrides: Partial<UploadManifest> = {}): UploadManifest {
  return {
    videoId: 'vid-1',
    r2Key: 'u1/vid-1/clip.mp4',
    multipartUploadId: 'mp-1',
    title: 'hi',
    description: '',
    fileName: 'clip.mp4',
    contentType: 'video/mp4',
    chunkCount: 3,
    parts: {},
    createdAt: 0,
    ...overrides,
  };
}

describe('manifestKey', () => {
  it('namespaces by user id and upload id', () => {
    expect(manifestKey('user-1', 'up-abc')).toBe('upload:user-1:up-abc');
  });
});

describe('part number conversion', () => {
  it('round-trips chunk index ↔ part number (R2 multipart parts are 1-indexed)', () => {
    expect(partNumberForChunkIndex(0)).toBe(1);
    expect(partNumberForChunkIndex(7)).toBe(8);
    expect(chunkIndexForPartNumber(1)).toBe(0);
    expect(chunkIndexForPartNumber(8)).toBe(7);
  });
});

describe('save / load / delete manifest', () => {
  it('persists and retrieves a manifest by (user, uploadId)', async () => {
    const env = { SESSIONS: fakeKV() };
    const m = buildManifest({
      parts: { '1': { etag: 'e1', size: 1024 } },
    });
    await saveManifest(env, 'user-1', 'up-1', m);
    const loaded = await loadManifest(env, 'user-1', 'up-1');
    expect(loaded).toEqual(m);
  });

  it('returns null for a missing manifest', async () => {
    const env = { SESSIONS: fakeKV() };
    expect(await loadManifest(env, 'user-1', 'nope')).toBeNull();
  });

  it('returns null when KV holds garbage (manifest schema-mismatch)', async () => {
    const env = { SESSIONS: fakeKV() };
    await env.SESSIONS.put(manifestKey('user-1', 'up-1'), 'not-json');
    expect(await loadManifest(env, 'user-1', 'up-1')).toBeNull();
    await env.SESSIONS.put(
      manifestKey('user-1', 'up-2'),
      JSON.stringify({ videoId: 'x' /* missing required fields */ }),
    );
    expect(await loadManifest(env, 'user-1', 'up-2')).toBeNull();
  });

  it('isolates manifests by user (user A cannot read user B)', async () => {
    const env = { SESSIONS: fakeKV() };
    const m = buildManifest();
    await saveManifest(env, 'user-A', 'up-1', m);
    expect(await loadManifest(env, 'user-B', 'up-1')).toBeNull();
  });

  it('deletes a manifest', async () => {
    const env = { SESSIONS: fakeKV() };
    await saveManifest(env, 'user-1', 'up-1', buildManifest());
    await deleteManifest(env, 'user-1', 'up-1');
    expect(await loadManifest(env, 'user-1', 'up-1')).toBeNull();
  });
});

describe('manifestProgress', () => {
  it('reports an empty manifest as zero received chunks, nextChunkIndex=0', () => {
    const m = buildManifest({ chunkCount: 5 });
    const p = manifestProgress('up-1', m);
    expect(p).toEqual({
      uploadId: 'up-1',
      chunkCount: 5,
      receivedChunks: [],
      receivedBytes: 0,
      nextChunkIndex: 0,
      complete: false,
    });
  });

  it('reports received chunk indices sorted, with bytes and the first gap', () => {
    const m = buildManifest({
      chunkCount: 4,
      // out-of-order keys to prove the sort
      parts: {
        '3': { etag: 'e3', size: 200 },
        '1': { etag: 'e1', size: 100 },
      },
    });
    const p = manifestProgress('up-1', m);
    // partNumbers {1, 3} → chunkIndexes {0, 2} → first gap is 1
    expect(p.receivedChunks).toEqual([0, 2]);
    expect(p.receivedBytes).toBe(300);
    expect(p.nextChunkIndex).toBe(1);
    expect(p.complete).toBe(false);
  });

  it('points nextChunkIndex past a contiguous run of received chunks', () => {
    const m = buildManifest({
      chunkCount: 4,
      parts: {
        '1': { etag: 'e1', size: 1 },
        '2': { etag: 'e2', size: 1 },
      },
    });
    expect(manifestProgress('up-1', m).nextChunkIndex).toBe(2);
  });

  it('marks complete when all chunks have arrived (nextChunkIndex=null)', () => {
    const m = buildManifest({
      chunkCount: 2,
      parts: {
        '1': { etag: 'e1', size: 100 },
        '2': { etag: 'e2', size: 100 },
      },
    });
    const p = manifestProgress('up-1', m);
    expect(p.complete).toBe(true);
    expect(p.nextChunkIndex).toBeNull();
  });
});

describe('totalBytesInManifest', () => {
  it('sums part sizes', () => {
    const m = buildManifest({
      parts: {
        '1': { etag: 'e1', size: 1000 },
        '2': { etag: 'e2', size: 250 },
        '3': { etag: 'e3', size: 0 },
      },
    });
    expect(totalBytesInManifest(m)).toBe(1250);
  });
});

describe('completedPartsForR2', () => {
  it('returns parts sorted by partNumber, ready for R2 multipart.complete()', () => {
    const m = buildManifest({
      parts: {
        '3': { etag: 'e3', size: 1 },
        '1': { etag: 'e1', size: 1 },
        '2': { etag: 'e2', size: 1 },
      },
    });
    expect(completedPartsForR2(m)).toEqual([
      { partNumber: 1, etag: 'e1' },
      { partNumber: 2, etag: 'e2' },
      { partNumber: 3, etag: 'e3' },
    ]);
  });
});

describe('uploadManifestSchema', () => {
  it('defaults parts to an empty object when omitted', () => {
    const result = uploadManifestSchema.safeParse({
      videoId: 'v',
      r2Key: 'k',
      multipartUploadId: 'mp',
      title: 't',
      description: '',
      fileName: 'f',
      contentType: 'video/mp4',
      chunkCount: 2,
      createdAt: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parts).toEqual({});
    }
  });
});
