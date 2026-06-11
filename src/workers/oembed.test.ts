import { describe, expect, it } from 'vitest';
import {
  buildOembedLinkResponse,
  extractWatchId,
  oembedRoutes,
  type OembedEnv,
  type OembedVideoResponse,
} from './oembed';

describe('extractWatchId', () => {
  it('extracts a watch id when host and path match', () => {
    expect(extractWatchId('https://spooool.com/watch/abc123', 'spooool.com')).toBe('abc123');
  });

  it('decodes percent-encoded segments', () => {
    expect(extractWatchId('https://spooool.com/watch/abc%20def', 'spooool.com')).toBe('abc def');
  });

  it('is host-comparison case-insensitive', () => {
    expect(extractWatchId('https://Spooool.com/watch/abc', 'spooool.com')).toBe('abc');
  });

  it('rejects URLs from a different host', () => {
    expect(extractWatchId('https://evil.example/watch/abc', 'spooool.com')).toBeNull();
  });

  it('rejects non-/watch paths', () => {
    expect(extractWatchId('https://spooool.com/channel/alice', 'spooool.com')).toBeNull();
    expect(extractWatchId('https://spooool.com/', 'spooool.com')).toBeNull();
  });

  it('rejects extra path segments', () => {
    expect(extractWatchId('https://spooool.com/watch/abc/extra', 'spooool.com')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(extractWatchId('not a url', 'spooool.com')).toBeNull();
  });

  it('rejects empty or oversized ids', () => {
    expect(extractWatchId('https://spooool.com/watch/', 'spooool.com')).toBeNull();
    const long = 'a'.repeat(200);
    expect(extractWatchId(`https://spooool.com/watch/${long}`, 'spooool.com')).toBeNull();
  });

  it('returns null instead of throwing on malformed percent-encoding', () => {
    expect(extractWatchId('https://spooool.com/watch/%E0%A4%A', 'spooool.com')).toBeNull();
    expect(extractWatchId('https://spooool.com/watch/%FF', 'spooool.com')).toBeNull();
  });

  it('rejects ids that decode to contain a slash', () => {
    expect(extractWatchId('https://spooool.com/watch/abc%2Fdef', 'spooool.com')).toBeNull();
  });
});

describe('buildOembedLinkResponse', () => {
  it('shapes a complete video response when all fields exist', () => {
    const out: OembedVideoResponse = buildOembedLinkResponse({
      origin: 'https://spooool.com',
      videoId: 'abc123',
      video: {
        title: 'My Video',
        thumbnail_url: 'https://thumbs.example/abc.jpg',
        channel_name: 'Alice',
        channel_username: 'alice',
      },
    });
    expect(out.type).toBe('video');
    expect(out.version).toBe('1.0');
    expect(out.provider_name).toBe('spooool');
    expect(out.provider_url).toBe('https://spooool.com');
    expect(out.title).toBe('My Video');
    expect(out.author_name).toBe('Alice');
    expect(out.author_url).toBe('https://spooool.com/channel/alice');
    expect(out.html).toContain('https://spooool.com/embed/abc123');
    expect(out.html).toContain('<iframe');
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
    expect(out.thumbnail_url).toBe('https://thumbs.example/abc.jpg');
    expect(out.thumbnail_width).toBe(1280);
    expect(out.thumbnail_height).toBe(720);
    expect(out.cache_age).toBe(300);
  });

  it('omits thumbnail fields when no thumbnail is set', () => {
    const out = buildOembedLinkResponse({
      origin: 'https://spooool.com',
      videoId: 'abc123',
      video: {
        title: 'My Video',
        thumbnail_url: null,
        channel_name: 'Alice',
        channel_username: 'alice',
      },
    });
    expect(out.thumbnail_url).toBeUndefined();
    expect(out.thumbnail_width).toBeUndefined();
    expect(out.thumbnail_height).toBeUndefined();
  });

  it('falls back to provider origin when channel username is missing', () => {
    const out = buildOembedLinkResponse({
      origin: 'https://spooool.com',
      videoId: 'abc123',
      video: {
        title: 'V',
        thumbnail_url: null,
        channel_name: null,
        channel_username: null,
      },
    });
    expect(out.author_url).toBe('https://spooool.com');
    expect(out.author_name).toBe('');
  });

  it('percent-encodes the channel username in author_url', () => {
    const out = buildOembedLinkResponse({
      origin: 'https://spooool.com',
      videoId: 'abc123',
      video: {
        title: 'V',
        thumbnail_url: null,
        channel_name: 'Alice & Bob',
        channel_username: 'alice & bob',
      },
    });
    expect(out.author_url).toBe('https://spooool.com/channel/alice%20%26%20bob');
  });
});

interface FakePrepared {
  bind: (...values: unknown[]) => FakePrepared;
  first: <T>() => Promise<T | null>;
}

function fakeDB(row: Record<string, unknown> | null): D1Database {
  const stmt = (): FakePrepared => {
    const api: FakePrepared = {
      bind: () => api,
      first: async () => row as never,
    };
    return api;
  };
  return { prepare: stmt } as unknown as D1Database;
}

describe('oembedRoutes — /api/oembed', () => {
  it('400s when url query is missing or invalid', async () => {
    const env: OembedEnv = { DB: fakeDB(null) };
    const res = await oembedRoutes.request('/api/oembed', {}, env);
    expect(res.status).toBe(400);
    const bad = await oembedRoutes.request('/api/oembed?url=not-a-url', {}, env);
    expect(bad.status).toBe(400);
  });

  it('404s when the URL is not a watch page on this host', async () => {
    const env: OembedEnv = { DB: fakeDB(null) };
    const res = await oembedRoutes.request(
      '/api/oembed?url=https%3A%2F%2Fevil.example%2Fwatch%2Fabc',
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it('404s when the video does not exist', async () => {
    const env: OembedEnv = { DB: fakeDB(null) };
    const res = await oembedRoutes.request(
      '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fmissing',
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it('hides DMCA-disabled and hidden videos', async () => {
    const hiddenEnv: OembedEnv = {
      DB: fakeDB({
        id: 'abc',
        title: 'T',
        status: 'ready',
        thumbnail_url: null,
        channel_name: 'A',
        channel_username: 'a',
        hidden_at: '2026-04-01 00:00:00',
        dmca_status: null,
        deleted_at: null,
      }),
    };
    const hiddenRes = await oembedRoutes.request(
      '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fabc',
      {},
      hiddenEnv,
    );
    expect(hiddenRes.status).toBe(404);

    const dmcaEnv: OembedEnv = {
      DB: fakeDB({
        id: 'abc',
        title: 'T',
        status: 'ready',
        thumbnail_url: null,
        channel_name: 'A',
        channel_username: 'a',
        hidden_at: null,
        dmca_status: 'disabled',
        deleted_at: null,
      }),
    };
    const dmcaRes = await oembedRoutes.request(
      '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fabc',
      {},
      dmcaEnv,
    );
    expect(dmcaRes.status).toBe(404);
  });

  it('hides videos that are not yet ready', async () => {
    for (const status of ['processing', 'failed', null]) {
      const env: OembedEnv = {
        DB: fakeDB({
          id: 'abc',
          title: 'T',
          status,
          thumbnail_url: null,
          channel_name: 'A',
          channel_username: 'a',
          hidden_at: null,
          dmca_status: null,
          deleted_at: null,
        }),
      };
      const res = await oembedRoutes.request(
        '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fabc',
        {},
        env,
      );
      expect(res.status).toBe(404);
    }
  });

  it('rejects unsupported format values without 500ing', async () => {
    const env: OembedEnv = { DB: fakeDB(null) };
    const res = await oembedRoutes.request(
      '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fabc&format=xml',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns a video-type oEmbed payload for a public video', async () => {
    const env: OembedEnv = {
      DB: fakeDB({
        id: 'abc',
        title: 'Hello',
        status: 'ready',
        thumbnail_url: 'https://thumbs.example/abc.jpg',
        channel_name: 'Alice',
        channel_username: 'alice',
        hidden_at: null,
        dmca_status: null,
        deleted_at: null,
      }),
    };
    const res = await oembedRoutes.request(
      '/api/oembed?url=http%3A%2F%2Flocalhost%2Fwatch%2Fabc',
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('video');
    expect(body.version).toBe('1.0');
    expect(body.provider_name).toBe('spooool');
    expect(body.title).toBe('Hello');
    expect(body.author_name).toBe('Alice');
    expect(body.author_url).toBe('http://localhost/channel/alice');
    expect(body.thumbnail_url).toBe('https://thumbs.example/abc.jpg');
    expect(typeof body.html).toBe('string');
    expect((body.html as string)).toContain('/embed/abc');
  });
});
