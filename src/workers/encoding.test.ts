import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStreamSourceUrl,
  handleEncodingMessage,
  sendToStream,
  STREAM_SOURCE_URL_TTL_SECONDS,
  verifyStreamSourceSignature,
  type EncodingEnv,
} from './encoding';

interface FakeRow {
  id: string;
  status: string;
  stream_video_id: string | null;
}

function makeFakeDB(seed: FakeRow[]): { rows: FakeRow[]; binding: D1Database } {
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
          // transitionVideoStatus binds: status, streamVideoId, videoId, ...allowedFrom
          const [status, streamVideoId, videoId, ...allowedFrom] = bound as [
            string,
            string | null,
            string,
            ...string[],
          ];
          const allowed = new Set(allowedFrom);
          let changes = 0;
          for (const row of rows) {
            if (row.id === videoId && allowed.has(row.status)) {
              row.status = status;
              if (streamVideoId) row.stream_video_id = streamVideoId;
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

const baseEnv = (): EncodingEnv => ({
  DB: {} as D1Database,
  STREAM_ENABLED: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CF_STREAM_API_TOKEN: 'tok',
  STREAM_SOURCE_ORIGIN: 'https://spooool.test',
  CF_STREAM_WEBHOOK_SECRET: 'shh',
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildStreamSourceUrl', () => {
  it('produces a signed HTTPS URL Cloudflare Stream can pull', async () => {
    const url = await buildStreamSourceUrl(baseEnv(), 'u/v/movie.mp4', 1_700_000_000);
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://spooool.test');
    expect(parsed.pathname).toBe('/api/internal/stream-source');
    expect(parsed.searchParams.get('key')).toBe('u/v/movie.mp4');
    expect(parsed.searchParams.get('exp')).toBe(
      String(1_700_000_000 + STREAM_SOURCE_URL_TTL_SECONDS),
    );
    expect(parsed.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws when the signing secret is missing', async () => {
    const env = { ...baseEnv(), CF_STREAM_WEBHOOK_SECRET: undefined };
    await expect(buildStreamSourceUrl(env, 'k', 1)).rejects.toThrow(
      /CF_STREAM_WEBHOOK_SECRET/,
    );
  });

  it('throws when no origin is configured', async () => {
    const env = {
      ...baseEnv(),
      STREAM_SOURCE_ORIGIN: undefined,
      BETTER_AUTH_URL: undefined,
    };
    await expect(buildStreamSourceUrl(env, 'k', 1)).rejects.toThrow(/STREAM_SOURCE_ORIGIN/);
  });
});

describe('verifyStreamSourceSignature', () => {
  it('round-trips a freshly built URL', async () => {
    const env = baseEnv();
    const now = 1_700_000_000;
    const url = await buildStreamSourceUrl(env, 'u/v/x.mp4', now);
    const parsed = new URL(url);
    const result = await verifyStreamSourceSignature(
      env,
      'u/v/x.mp4',
      Number(parsed.searchParams.get('exp')),
      parsed.searchParams.get('sig') ?? '',
      now,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an expired signature', async () => {
    const env = baseEnv();
    const now = 1_700_000_000;
    const url = await buildStreamSourceUrl(env, 'k', now);
    const parsed = new URL(url);
    const result = await verifyStreamSourceSignature(
      env,
      'k',
      Number(parsed.searchParams.get('exp')),
      parsed.searchParams.get('sig') ?? '',
      now + STREAM_SOURCE_URL_TTL_SECONDS + 1,
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered key', async () => {
    const env = baseEnv();
    const now = 1_700_000_000;
    const url = await buildStreamSourceUrl(env, 'good-key', now);
    const parsed = new URL(url);
    const result = await verifyStreamSourceSignature(
      env,
      'evil-key',
      Number(parsed.searchParams.get('exp')),
      parsed.searchParams.get('sig') ?? '',
      now,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('reports missing secret', async () => {
    const env = { ...baseEnv(), CF_STREAM_WEBHOOK_SECRET: undefined };
    const result = await verifyStreamSourceSignature(env, 'k', 1, 'aa');
    expect(result).toEqual({ ok: false, reason: 'missing_secret' });
  });
});

describe('sendToStream', () => {
  it('POSTs to /stream/copy with the signed source URL and returns the uid', async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct123/stream/copy',
      );
      const body = JSON.parse(init?.body as string);
      expect(body.url).toMatch(/^https:\/\/spooool\.test\/api\/internal\/stream-source\?/);
      expect(body.requireSignedURLs).toBe(false);
      expect(body.meta).toEqual({ r2Key: 'u/v/clip.mp4' });
      return new Response(JSON.stringify({ result: { uid: 'STREAM-UID-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const uid = await sendToStream(baseEnv(), 'u/v/clip.mp4');
    expect(uid).toBe('STREAM-UID-1');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('throws when Stream rejects the copy', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(sendToStream(baseEnv(), 'k')).rejects.toThrow(/Stream API failed: 429/);
  });

  it('throws when the response is missing the uid', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(sendToStream(baseEnv(), 'k')).rejects.toThrow(/missing video uid/);
  });
});

describe('handleEncodingMessage', () => {
  it('ignores messages with the wrong shape', async () => {
    const { binding } = makeFakeDB([{ id: 'v1', status: 'queued', stream_video_id: null }]);
    const env: EncodingEnv = { ...baseEnv(), DB: binding };
    await expect(handleEncodingMessage(env, { wrong: 'shape' })).resolves.toBeUndefined();
  });

  it('does nothing when STREAM_ENABLED is not "true"', async () => {
    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null },
    ]);
    const env: EncodingEnv = { ...baseEnv(), DB: binding, STREAM_ENABLED: 'false' };
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await handleEncodingMessage(env, { videoId: 'v1', r2Key: 'r2/key' });
    expect(rows[0].status).toBe('queued');
  });

  it('moves the row to encoding and stores the stream uid on success', async () => {
    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null },
    ]);
    const env: EncodingEnv = { ...baseEnv(), DB: binding };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { uid: 'STREAM-UID-2' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await handleEncodingMessage(env, { videoId: 'v1', r2Key: 'r2/key' });
    expect(rows[0].status).toBe('encoding');
    expect(rows[0].stream_video_id).toBe('STREAM-UID-2');
  });

  it('flips the row to failed and rethrows when the Stream call errors', async () => {
    const { rows, binding } = makeFakeDB([
      { id: 'v1', status: 'queued', stream_video_id: null },
    ]);
    const env: EncodingEnv = { ...baseEnv(), DB: binding };
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    await expect(handleEncodingMessage(env, { videoId: 'v1', r2Key: 'r2/key' })).rejects.toThrow(
      /Encoding failed for video v1/,
    );
    expect(rows[0].status).toBe('failed');
  });
});
