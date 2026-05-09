import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pollStuckEncodings,
  POLL_BATCH_LIMIT,
  STUCK_AFTER_SECONDS,
  type StreamPollEnv,
} from './stream-poll';

interface FakeRow {
  id: string;
  stream_video_id: string | null;
  status: string;
  playback_hls_url: string | null;
  thumbnail_url: string | null;
  thumbnail_candidates: string | null;
  updated_at: string;
}

function makeFakeDB(seed: FakeRow[]): { rows: FakeRow[]; binding: D1Database } {
  const rows = [...seed];
  const db = {
    prepare(query: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async all<T>() {
          // SELECT id, stream_video_id FROM videos WHERE status='encoding' AND
          //   stream_video_id IS NOT NULL AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?
          const [cutoff, limit] = bound as [string, number];
          const matches = rows
            .filter(
              (r): r is FakeRow & { stream_video_id: string } =>
                r.status === 'encoding' &&
                r.stream_video_id !== null &&
                r.updated_at <= cutoff,
            )
            .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
            .slice(0, limit)
            .map((r) => ({ id: r.id, stream_video_id: r.stream_video_id }));
          return { results: matches as unknown as T[] };
        },
        async run() {
          // UPDATE videos SET status=?, playback_hls_url=COALESCE(?, ...),
          //   thumbnail_url=COALESCE(?, ...), thumbnail_candidates=COALESCE(?, ...),
          //   updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN (...)
          const [status, playbackHls, thumbnail, candidates, videoId, ...allowedFrom] =
            bound as [
              string,
              string | null,
              string | null,
              string | null,
              string,
              ...string[],
            ];
          // Sanity: we expect the polling SQL to include the COALESCE form.
          expect(query).toMatch(/COALESCE/);
          const allowed = new Set(allowedFrom);
          let changes = 0;
          for (const row of rows) {
            if (row.id === videoId && allowed.has(row.status)) {
              row.status = status;
              if (playbackHls !== null) row.playback_hls_url = playbackHls;
              if (thumbnail !== null) row.thumbnail_url = thumbnail;
              if (candidates !== null) row.thumbnail_candidates = candidates;
              row.updated_at = new Date().toISOString();
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

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const STUCK_ISO = new Date(NOW_MS - (STUCK_AFTER_SECONDS + 60) * 1000).toISOString();
const FRESH_ISO = new Date(NOW_MS - 30 * 1000).toISOString();

function envFor(db: D1Database, overrides: Partial<StreamPollEnv> = {}): StreamPollEnv {
  return {
    DB: db,
    STREAM_ENABLED: 'true',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CF_STREAM_API_TOKEN: 'tok',
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pollStuckEncodings', () => {
  it('returns [] when STREAM_ENABLED is not "true"', async () => {
    const { binding } = makeFakeDB([]);
    const env = envFor(binding, { STREAM_ENABLED: 'false' });
    const result = await pollStuckEncodings(env, NOW_MS);
    expect(result).toEqual([]);
  });

  it('skips rows that haven been encoding for less than the stuck cutoff', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: FRESH_ISO,
      },
    ]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('encoding');
  });

  it('flips a stuck row to ready and stores the HLS manifest URL', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: STUCK_ISO,
      },
    ]);

    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/stream/uid1');
      return new Response(
        JSON.stringify({
          result: {
            uid: 'uid1',
            status: { state: 'ready' },
            playback: { hls: 'https://videodelivery.net/uid1/manifest/video.m3u8' },
            thumbnail: 'https://videodelivery.net/uid1/thumbnails/thumbnail.jpg',
            duration: 60,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ videoId: 'v1', status: 'ready', changes: 1 });
    expect(rows[0].status).toBe('ready');
    expect(rows[0].playback_hls_url).toBe('https://videodelivery.net/uid1/manifest/video.m3u8');
    expect(rows[0].thumbnail_url).toBe('https://videodelivery.net/uid1/thumbnails/thumbnail.jpg');
    expect(rows[0].thumbnail_candidates).not.toBeNull();
  });

  it('flips a stuck row to failed when Stream reports an error state', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: STUCK_ISO,
      },
    ]);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: { uid: 'uid1', status: { state: 'error', errorReasonText: 'bad source' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result[0].status).toBe('failed');
    expect(rows[0].status).toBe('failed');
  });

  it('reports an error result without throwing when the Stream API rejects', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: STUCK_ISO,
      },
    ]);
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0].error).toMatch(/Stream GET failed: 500/);
    // Row stays in encoding so the next poll retries.
    expect(rows[0].status).toBe('encoding');
  });

  it('does not drag a row that already moved to ready back to encoding', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid1',
        status: 'ready',
        playback_hls_url: 'https://videodelivery.net/uid1/manifest/video.m3u8',
        thumbnail_url: null,
        thumbnail_candidates: null,
        updated_at: STUCK_ISO,
      },
    ]);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ result: { uid: 'uid1', status: { state: 'inprogress' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    // The SELECT only matches rows in 'encoding' so this row isn't even
    // visited — confirm the helper returns empty rather than crashing.
    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result).toEqual([]);
    expect(rows[0].status).toBe('ready');
  });

  it('caps the batch at POLL_BATCH_LIMIT', async () => {
    expect(POLL_BATCH_LIMIT).toBeGreaterThan(0);
    const seed: FakeRow[] = Array.from({ length: POLL_BATCH_LIMIT + 5 }, (_, i) => ({
      id: `v${i}`,
      stream_video_id: `uid${i}`,
      status: 'encoding',
      playback_hls_url: null,
      thumbnail_url: null,
      thumbnail_candidates: null,
      updated_at: STUCK_ISO,
    }));
    const { binding } = makeFakeDB(seed);
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ result: { uid: 'x', status: { state: 'inprogress' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await pollStuckEncodings(envFor(binding), NOW_MS);
    expect(result).toHaveLength(POLL_BATCH_LIMIT);
    expect(fetchSpy).toHaveBeenCalledTimes(POLL_BATCH_LIMIT);
  });
});
