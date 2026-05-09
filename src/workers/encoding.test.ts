import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEncodingMessage, hlsOutputPrefix, type EncodingEnv } from './encoding';

interface FakeRow {
  id: string;
  status: string;
  stream_video_id: string | null;
  updated_at: number;
}

function makeFakeDB(seed: FakeRow[] = []): { rows: FakeRow[]; binding: D1Database } {
  const rows = [...seed];
  const db = {
    prepare(_query: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async run() {
          // transitionVideoStatus binds:
          //   to, streamVideoId, videoId, ...allowedFromStatuses
          const [to, streamVideoId, videoId, ...allowedFrom] = bound as [
            string,
            string | null,
            string,
            ...string[],
          ];
          const allowed = new Set(allowedFrom);
          let changes = 0;
          for (const row of rows) {
            if (row.id === videoId && allowed.has(row.status)) {
              row.status = to;
              if (streamVideoId !== null) row.stream_video_id = streamVideoId;
              row.updated_at = Date.now();
              changes++;
            }
          }
          return { meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { rows, binding: db };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('hlsOutputPrefix', () => {
  it('appends hls/ to the source directory', () => {
    expect(hlsOutputPrefix('user-1/vid-2/source.mp4')).toBe('user-1/vid-2/hls/');
  });

  it('handles a key with no directory', () => {
    expect(hlsOutputPrefix('source.mp4')).toBe('source.mp4/hls/');
  });
});

describe('handleEncodingMessage — schema validation', () => {
  it('silently drops malformed payloads without touching the DB', async () => {
    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await handleEncodingMessage({ DB: binding } as EncodingEnv, { not: 'a job' });
    expect(rows[0].status).toBe('queued');
  });
});

describe('handleEncodingMessage — Stream path', () => {
  it('marks the row encoding and stores the Stream uid on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ result: { uid: 'stream-uid-123' } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await handleEncodingMessage(
      {
        DB: binding,
        STREAM_ENABLED: 'true',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CF_STREAM_API_TOKEN: 'tok',
      } satisfies EncodingEnv,
      { videoId: 'v1', r2Key: 'u/v1/source.mp4' },
    );
    expect(rows[0].status).toBe('encoding');
    expect(rows[0].stream_video_id).toBe('stream-uid-123');
  });

  it('flips the row to failed and rethrows when Stream errors', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await expect(
      handleEncodingMessage(
        {
          DB: binding,
          STREAM_ENABLED: 'true',
          CLOUDFLARE_ACCOUNT_ID: 'acct',
          CF_STREAM_API_TOKEN: 'tok',
        } satisfies EncodingEnv,
        { videoId: 'v1', r2Key: 'u/v1/source.mp4' },
      ),
    ).rejects.toThrow(/Encoding failed for video v1/);
    expect(rows[0].status).toBe('failed');
  });
});

describe('handleEncodingMessage — R2+FFmpeg fallback path', () => {
  it('marks the row encoding even when no encoder URL is configured', async () => {
    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await handleEncodingMessage({ DB: binding } as EncodingEnv, {
      videoId: 'v1',
      r2Key: 'u/v1/source.mp4',
    });
    expect(rows[0].status).toBe('encoding');
  });

  it('POSTs to the encoder URL with the source + output prefix', async () => {
    const captured: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        body: JSON.parse((init?.body as string) ?? '{}'),
        headers: new Headers(init?.headers ?? {}),
      });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await handleEncodingMessage(
      {
        DB: binding,
        FFMPEG_ENCODER_URL: 'https://encoder.test/encode',
      } satisfies EncodingEnv,
      { videoId: 'v1', r2Key: 'user-1/vid-2/source.mp4' },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('https://encoder.test/encode');
    expect(captured[0].body).toEqual({
      videoId: 'v1',
      sourceR2Key: 'user-1/vid-2/source.mp4',
      outputR2Prefix: 'user-1/vid-2/hls/',
    });
    expect(rows[0].status).toBe('encoding');
  });

  it('signs the dispatch when FFMPEG_ENCODER_SECRET is set', async () => {
    const captured: Array<{ headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ headers: new Headers(init?.headers ?? {}) });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const { binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await handleEncodingMessage(
      {
        DB: binding,
        FFMPEG_ENCODER_URL: 'https://encoder.test/encode',
        FFMPEG_ENCODER_SECRET: 'shhh',
      } satisfies EncodingEnv,
      { videoId: 'v1', r2Key: 'u/v1/source.mp4' },
    );

    const sig = captured[0].headers.get('x-ffmpeg-signature');
    expect(sig).not.toBeNull();
    expect(sig).toMatch(/^time=\d+,sig1=[0-9a-f]{64}$/);
  });

  it('flips to failed and rethrows when the encoder returns non-2xx', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('encoder unavailable', { status: 503 }),
    ) as unknown as typeof fetch;

    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null, updated_at: 0 },
    ]);
    await expect(
      handleEncodingMessage(
        {
          DB: binding,
          FFMPEG_ENCODER_URL: 'https://encoder.test/encode',
        } satisfies EncodingEnv,
        { videoId: 'v1', r2Key: 'u/v1/source.mp4' },
      ),
    ).rejects.toThrow(/Encoding failed for video v1/);
    expect(rows[0].status).toBe('failed');
  });
});
