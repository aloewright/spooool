import { describe, expect, it, vi } from 'vitest';
import { pollStreamForEncodingVideos } from './stream-poll';

interface FakeRow {
  id: string;
  stream_video_id: string;
  status: string;
  playback_hls_url: string | null;
  thumbnail_url: string | null;
  thumbnail_candidates: string | null;
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
        async run() {
          // UPDATE: status, playbackHls, thumbnail, candidates, id, ...allowedFrom
          const [status, playbackHls, thumbnail, candidates, id, ...allowedFrom] = bound as [
            string,
            string | null,
            string | null,
            string | null,
            string,
            ...string[],
          ];
          const allowedSet = new Set(allowedFrom);
          let changes = 0;
          for (const row of rows) {
            if (row.id === id && allowedSet.has(row.status)) {
              row.status = status;
              if (playbackHls !== null) row.playback_hls_url = playbackHls;
              if (thumbnail !== null) row.thumbnail_url = thumbnail;
              if (candidates !== null) row.thumbnail_candidates = candidates;
              changes++;
            }
          }
          return { meta: { changes } };
        },
        async all<T>() {
          if (query.includes('SELECT')) {
            const limit = bound[0] as number;
            return {
              results: rows
                .filter((r) => r.status === 'encoding' && r.stream_video_id)
                .slice(0, limit) as unknown as T[],
            };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { rows, binding: db };
}

describe('pollStreamForEncodingVideos', () => {
  it('no-ops when stream credentials are not configured', async () => {
    const { binding } = makeFakeDB([]);
    const result = await pollStreamForEncodingVideos({ DB: binding });
    expect(result).toEqual({ scanned: 0, updated: 0, errors: 0 });
  });

  it('promotes encoding rows to ready when stream reports ready', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid-1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          uid: 'uid-1',
          status: { state: 'ready' },
          playback: { hls: 'https://videodelivery.net/uid-1/manifest/video.m3u8' },
          thumbnail: 'https://videodelivery.net/uid-1/thumbnails/thumbnail.jpg',
          duration: 120,
        },
      }),
    });
    const result = await pollStreamForEncodingVideos(
      {
        DB: binding,
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CF_STREAM_API_TOKEN: 'tok',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result).toEqual({ scanned: 1, updated: 1, errors: 0 });
    expect(rows[0].status).toBe('ready');
    expect(rows[0].playback_hls_url).toContain('manifest');
    expect(rows[0].thumbnail_candidates).toContain('thumbnail.jpg');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct/stream/uid-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('counts errors when stream API responds non-OK', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid-1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const result = await pollStreamForEncodingVideos(
      { DB: binding, CLOUDFLARE_ACCOUNT_ID: 'acct', CF_STREAM_API_TOKEN: 'tok' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(0);
    expect(rows[0].status).toBe('encoding');
  });

  it('marks failed when stream reports error state', async () => {
    const { rows, binding } = makeFakeDB([
      {
        id: 'v1',
        stream_video_id: 'uid-1',
        status: 'encoding',
        playback_hls_url: null,
        thumbnail_url: null,
        thumbnail_candidates: null,
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { uid: 'uid-1', status: { state: 'error' } } }),
    });
    const result = await pollStreamForEncodingVideos(
      { DB: binding, CLOUDFLARE_ACCOUNT_ID: 'acct', CF_STREAM_API_TOKEN: 'tok' },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(result.updated).toBe(1);
    expect(rows[0].status).toBe('failed');
  });
});
