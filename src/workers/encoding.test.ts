import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEncodingMessage } from './encoding';
import type { VideoStatus } from './video-status';

interface FakeDB {
  prepare: (sql: string) => {
    bind: (...values: unknown[]) => {
      run: () => Promise<{ meta: { changes: number } }>;
    };
  };
  runs: Array<{ sql: string; bound: unknown[] }>;
  setStatus: (status: VideoStatus) => void;
}

function fakeDB(initialStatus: VideoStatus = 'queued'): FakeDB {
  let status: VideoStatus = initialStatus;
  const runs: Array<{ sql: string; bound: unknown[] }> = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        bound = values;
        return stmt;
      },
      run: async () => {
        runs.push({ sql, bound: [...bound] });
        // transitionVideoStatus binds [to, streamVideoId, videoId, ...allowedFrom].
        const [to, , , ...allowedFrom] = bound as [VideoStatus, unknown, string, ...VideoStatus[]];
        if (allowedFrom.includes(status)) {
          status = to;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    get runs() {
      return runs;
    },
    setStatus: (s: VideoStatus) => {
      status = s;
    },
  } as unknown as FakeDB;
}

const ORIGINAL_FETCH = globalThis.fetch;

// Encoding Env now requires ENCODE_CONTAINER; the Stream-path tests below don't
// exercise the container fallback, so a stub satisfies the type without being used.
const FAKE_ENCODE_CONTAINER = {} as unknown as DurableObjectNamespace;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('handleEncodingMessage', () => {
  it('returns silently on a malformed message (no DB writes)', async () => {
    const db = fakeDB();
    await handleEncodingMessage(
      { DB: db as unknown as D1Database, STREAM_ENABLED: 'true', ENCODE_CONTAINER: FAKE_ENCODE_CONTAINER },
      { not: 'valid' },
    );
    expect(db.runs).toHaveLength(0);
  });

  it('dispatches to EncoderContainer when STREAM_ENABLED is unset (R2 fallback path)', async () => {
    const db = fakeDB('queued');
    const containerFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const fakeStub = { fetch: containerFetch };
    const fakeNS = {
      idFromName: vi.fn(() => 'fake-id'),
      get: vi.fn(() => fakeStub),
    };
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await handleEncodingMessage(
      {
        DB: db as unknown as D1Database,
        ENCODE_CONTAINER: fakeNS as unknown as DurableObjectNamespace,
      },
      { videoId: 'v1', r2Key: 'k' },
    );

    // Should not have called the global fetch (Stream API).
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Should have transitioned the video to encoding.
    const updates = db.runs.filter((r) => r.sql.includes('UPDATE videos'));
    expect(updates).toHaveLength(1);
    expect(updates[0].bound[0]).toBe('encoding');
    // Should have dispatched to the encoder container.
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const call = containerFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe('https://encoder-container/encode');
    expect(JSON.parse(init.body as string)).toEqual({ videoId: 'v1', r2Key: 'k' });
  });

  it('submits to the Stream API and captures the returned uid', async () => {
    const db = fakeDB('queued');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: { uid: 'stream-uid-42' } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await handleEncodingMessage(
      {
        DB: db as unknown as D1Database,
        STREAM_ENABLED: 'true',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CF_STREAM_API_TOKEN: 'tok',
        ENCODE_CONTAINER: FAKE_ENCODE_CONTAINER,
      },
      { videoId: 'v1', r2Key: 'videos/v1.mp4' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/stream');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'r2://spooool-videos/videos/v1.mp4',
      requireSignedURLs: false,
    });

    // Two UPDATE runs: queued→encoding, then encoding→encoding with stream uid.
    const updates = db.runs.filter((r) => r.sql.includes('UPDATE videos'));
    expect(updates).toHaveLength(2);
    expect(updates[1].bound[1]).toBe('stream-uid-42');
  });

  it('marks the video failed and rethrows when Stream config is missing', async () => {
    const db = fakeDB('queued');
    await expect(
      handleEncodingMessage(
        { DB: db as unknown as D1Database, STREAM_ENABLED: 'true', ENCODE_CONTAINER: FAKE_ENCODE_CONTAINER },
        { videoId: 'v1', r2Key: 'k' },
      ),
    ).rejects.toThrow(/Encoding failed/);

    // queued→encoding fires before the config check in sendToStream throws,
    // so we always observe both transitions even when no API call goes out.
    const updates = db.runs.filter((r) => r.sql.includes('UPDATE videos'));
    expect(updates).toHaveLength(2);
    expect(updates[0].bound[0]).toBe('encoding');
    expect(updates[1].bound[0]).toBe('failed');
  });

  it('marks the video failed when the Stream API responds non-2xx', async () => {
    const db = fakeDB('queued');
    globalThis.fetch = (async () =>
      new Response('rate-limited', { status: 429 })) as unknown as typeof fetch;

    await expect(
      handleEncodingMessage(
        {
          DB: db as unknown as D1Database,
          STREAM_ENABLED: 'true',
          CLOUDFLARE_ACCOUNT_ID: 'acct',
          CF_STREAM_API_TOKEN: 'tok',
          ENCODE_CONTAINER: FAKE_ENCODE_CONTAINER,
        },
        { videoId: 'v1', r2Key: 'k' },
      ),
    ).rejects.toThrow(/Stream API failed: 429/);

    const updates = db.runs.filter((r) => r.sql.includes('UPDATE videos'));
    expect(updates).toHaveLength(2);
    expect(updates[0].bound[0]).toBe('encoding');
    expect(updates[1].bound[0]).toBe('failed');
  });

  it('marks the video failed when the Stream API response is missing the uid', async () => {
    const db = fakeDB('queued');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: {} }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      handleEncodingMessage(
        {
          DB: db as unknown as D1Database,
          STREAM_ENABLED: 'true',
          CLOUDFLARE_ACCOUNT_ID: 'acct',
          CF_STREAM_API_TOKEN: 'tok',
          ENCODE_CONTAINER: FAKE_ENCODE_CONTAINER,
        },
        { videoId: 'v1', r2Key: 'k' },
      ),
    ).rejects.toThrow(/missing video uid/);
    const updates = db.runs.filter((r) => r.sql.includes('UPDATE videos'));
    expect(updates).toHaveLength(2);
    expect(updates[0].bound[0]).toBe('encoding');
    expect(updates[1].bound[0]).toBe('failed');
  });
});
