import { describe, expect, it } from 'vitest';
import {
  abortUploadSession,
  deleteUploadSession,
  readUploadSession,
  uploadedChunkIndices,
  uploadMetaPersistedSchema,
  uploadSessionKeys,
} from './upload-session';

class FakeKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

interface FakeMultipartUpload {
  abort(): Promise<void>;
}

class FakeR2 {
  abortCalls: Array<{ key: string; uploadId: string }> = [];
  resumeMultipartUpload(key: string, uploadId: string): FakeMultipartUpload {
    return {
      abort: async () => {
        this.abortCalls.push({ key, uploadId });
      },
    };
  }
}

function envFor(): { SESSIONS: KVNamespace; VIDEOS: R2Bucket; kv: FakeKV; r2: FakeR2 } {
  const kv = new FakeKV();
  const r2 = new FakeR2();
  return {
    SESSIONS: kv as unknown as KVNamespace,
    VIDEOS: r2 as unknown as R2Bucket,
    kv,
    r2,
  };
}

describe('uploadSessionKeys', () => {
  it('namespaces by user id and upload id', () => {
    const keys = uploadSessionKeys('u1', 'up-abc');
    expect(keys.base).toBe('upload:u1:up-abc');
    expect(keys.mpid).toBe('upload:u1:up-abc:mpid');
    expect(keys.meta).toBe('upload:u1:up-abc:meta');
    expect(keys.parts).toBe('upload:u1:up-abc:parts');
  });
});

describe('uploadMetaPersistedSchema', () => {
  it('parses the legacy shape (no fingerprint fields)', () => {
    const parsed = uploadMetaPersistedSchema.safeParse({
      videoId: 'v1',
      r2Key: 'u1/v1/clip.mp4',
      title: 'hi',
      description: '',
      chunkCount: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses with fingerprint fields', () => {
    const parsed = uploadMetaPersistedSchema.safeParse({
      videoId: 'v1',
      r2Key: 'u1/v1/clip.mp4',
      title: 'hi',
      description: '',
      chunkCount: 3,
      fileName: 'clip.mp4',
      fileSize: 1024,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-positive chunkCount', () => {
    const parsed = uploadMetaPersistedSchema.safeParse({
      videoId: 'v1',
      r2Key: 'k',
      title: 't',
      description: '',
      chunkCount: 0,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('readUploadSession', () => {
  it('returns null when the session is missing', async () => {
    const env = envFor();
    expect(await readUploadSession(env, 'u1', 'missing')).toBeNull();
  });

  it('reads back a session with parts manifest', async () => {
    const env = envFor();
    const keys = uploadSessionKeys('u1', 'up-1');
    await env.kv.put(keys.mpid, 'mpid-xyz');
    await env.kv.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u1/v1/clip.mp4',
        title: 'hi',
        description: 'd',
        chunkCount: 3,
        fileName: 'clip.mp4',
        fileSize: 999,
      }),
    );
    await env.kv.put(
      keys.parts,
      JSON.stringify({
        '1': { etag: 'e1', size: 10 },
        '2': { etag: 'e2', size: 20 },
      }),
    );

    const session = await readUploadSession(env, 'u1', 'up-1');
    expect(session).not.toBeNull();
    expect(session?.multipartUploadId).toBe('mpid-xyz');
    expect(session?.meta.fileName).toBe('clip.mp4');
    expect(session?.parts['1'].etag).toBe('e1');
    expect(session?.parts['2'].size).toBe(20);
  });

  it('returns null when the meta JSON is malformed', async () => {
    const env = envFor();
    const keys = uploadSessionKeys('u1', 'up-bad');
    await env.kv.put(keys.mpid, 'm');
    await env.kv.put(keys.meta, '{not-json');
    expect(await readUploadSession(env, 'u1', 'up-bad')).toBeNull();
  });

  it('drops malformed individual part entries but keeps valid ones', async () => {
    const env = envFor();
    const keys = uploadSessionKeys('u1', 'up-mix');
    await env.kv.put(keys.mpid, 'm');
    await env.kv.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'k',
        title: 't',
        description: '',
        chunkCount: 2,
      }),
    );
    await env.kv.put(
      keys.parts,
      JSON.stringify({
        '1': { etag: 'good', size: 5 },
        '2': { etag: 'bad' },
      }),
    );
    const session = await readUploadSession(env, 'u1', 'up-mix');
    expect(session?.parts['1']).toEqual({ etag: 'good', size: 5 });
    expect(session?.parts['2']).toBeUndefined();
  });
});

describe('uploadedChunkIndices', () => {
  it('converts 1-indexed part numbers to 0-indexed chunk indices, sorted', () => {
    const out = uploadedChunkIndices({
      '3': { etag: 'e3', size: 1 },
      '1': { etag: 'e1', size: 1 },
      '5': { etag: 'e5', size: 1 },
    });
    expect(out).toEqual([0, 2, 4]);
  });

  it('ignores non-integer part keys defensively', () => {
    const out = uploadedChunkIndices({
      foo: { etag: 'e', size: 1 },
      '1': { etag: 'e', size: 1 },
    });
    expect(out).toEqual([0]);
  });
});

describe('deleteUploadSession', () => {
  it('removes all three keys', async () => {
    const env = envFor();
    const keys = uploadSessionKeys('u1', 'up-d');
    await env.kv.put(keys.mpid, 'm');
    await env.kv.put(keys.meta, '{}');
    await env.kv.put(keys.parts, '{}');
    await deleteUploadSession(env, 'u1', 'up-d');
    expect(env.kv.has(keys.mpid)).toBe(false);
    expect(env.kv.has(keys.meta)).toBe(false);
    expect(env.kv.has(keys.parts)).toBe(false);
  });
});

describe('abortUploadSession', () => {
  it('aborts the R2 multipart and clears KV when the session exists', async () => {
    const env = envFor();
    const keys = uploadSessionKeys('u1', 'up-a');
    await env.kv.put(keys.mpid, 'mp-1');
    await env.kv.put(
      keys.meta,
      JSON.stringify({
        videoId: 'v1',
        r2Key: 'u1/v1/clip.mp4',
        title: 't',
        description: '',
        chunkCount: 2,
      }),
    );
    await env.kv.put(keys.parts, JSON.stringify({ '1': { etag: 'e1', size: 1 } }));

    const result = await abortUploadSession(env, 'u1', 'up-a');
    expect(result.aborted).toBe(true);
    expect(env.r2.abortCalls).toEqual([{ key: 'u1/v1/clip.mp4', uploadId: 'mp-1' }]);
    expect(env.kv.has(keys.mpid)).toBe(false);
    expect(env.kv.has(keys.meta)).toBe(false);
    expect(env.kv.has(keys.parts)).toBe(false);
  });

  it('returns aborted:false when the session is already gone, and still clears (idempotent)', async () => {
    const env = envFor();
    const result = await abortUploadSession(env, 'u1', 'never-existed');
    expect(result.aborted).toBe(false);
    expect(env.r2.abortCalls).toHaveLength(0);
  });
});
