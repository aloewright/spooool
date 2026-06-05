import { describe, expect, it } from 'vitest';
import {
  parseChannelInput,
  parsePlaylistInput,
  parseIso8601Duration,
  normalizePlaylistItem,
  normalizeSearchItem,
  getYouTubeChannelItems,
  getYouTubeSearchItems,
  resolveYouTubeChannel,
  YouTubeQuotaError,
  type YouTubeEnv,
} from './youtube';

describe('parseChannelInput', () => {
  it('reads @handle (bare and URL)', () => {
    expect(parseChannelInput('@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
    expect(parseChannelInput('https://www.youtube.com/@MrBeast')).toEqual({ by: 'handle', handle: 'MrBeast' });
  });
  it('reads /channel/UC… ids and bare UC ids', () => {
    const id = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
    expect(parseChannelInput(`https://youtube.com/channel/${id}`)).toEqual({ by: 'id', channelId: id });
    expect(parseChannelInput(id)).toEqual({ by: 'id', channelId: id });
  });
  it('reads legacy /user/NAME', () => {
    expect(parseChannelInput('https://www.youtube.com/user/PewDiePie')).toEqual({ by: 'username', username: 'PewDiePie' });
  });
  it('returns null for clearly invalid input', () => {
    expect(parseChannelInput('   ')).toBeNull();
    expect(parseChannelInput('https://example.com/foo')).toBeNull();
  });
});

describe('parsePlaylistInput', () => {
  it('extracts list= param', () => {
    expect(parsePlaylistInput('https://www.youtube.com/playlist?list=PLabc123')).toBe('PLabc123');
    expect(parsePlaylistInput('https://www.youtube.com/watch?v=x&list=UUxyz')).toBe('UUxyz');
  });
  it('accepts a bare playlist id', () => {
    expect(parsePlaylistInput('PLabc123')).toBe('PLabc123');
  });
  it('returns null otherwise', () => {
    expect(parsePlaylistInput('not a playlist')).toBeNull();
  });
});

describe('parseIso8601Duration', () => {
  it('parses H/M/S', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
    expect(parseIso8601Duration('PT45S')).toBe(45);
    expect(parseIso8601Duration('PT10M')).toBe(600);
  });
  it('returns null for junk', () => {
    expect(parseIso8601Duration('banana')).toBeNull();
  });
});

describe('normalizePlaylistItem', () => {
  it('maps a playlistItems.list entry to a FeedItem with a youtube embed', () => {
    const out = normalizePlaylistItem({
      snippet: {
        title: 'Cool Video',
        videoOwnerChannelTitle: 'Cool Channel',
        publishedAt: '2026-01-02T03:04:05Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } },
      },
      contentDetails: { videoId: 'abc123', videoPublishedAt: '2026-01-02T03:04:05Z' },
    });
    expect(out).toMatchObject({
      source: 'youtube',
      id: 'abc123',
      title: 'Cool Video',
      author: 'Cool Channel',
      thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      url: 'https://www.youtube.com/watch?v=abc123',
      embed: { kind: 'youtube', videoId: 'abc123' },
    });
    expect(out!.publishedAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('returns null when the videoId is missing', () => {
    expect(normalizePlaylistItem({ snippet: {}, contentDetails: {} })).toBeNull();
  });
});

describe('normalizeSearchItem', () => {
  it('maps a search.list entry to a FeedItem', () => {
    const out = normalizeSearchItem({
      id: { videoId: 'srch1' },
      snippet: {
        title: 'Found It',
        channelTitle: 'Finder',
        publishedAt: '2026-02-02T00:00:00Z',
        thumbnails: { medium: { url: 'https://i.ytimg.com/s.jpg' } },
      },
    });
    expect(out).toMatchObject({ source: 'youtube', id: 'srch1', embed: { kind: 'youtube', videoId: 'srch1' } });
  });
});

// minimal in-memory KV
function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function quotaResponse(): Response {
  return jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
}

describe('getYouTubeChannelItems', () => {
  it('resolves uploads playlist then lists items, and caches the result', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.includes('/channels')) {
        return jsonResponse({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_uploads' } } }] });
      }
      if (u.includes('/playlistItems')) {
        return jsonResponse({
          items: [{ snippet: { title: 'V', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { videoId: 'vid1' } }],
        });
      }
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const first = await getYouTubeChannelItems(env, 'UCX6OQ3DkcsbYNE6H8uQQuVA', fetcher);
    expect(first.items.map((i) => i.id)).toEqual(['vid1']);
    expect(first.error).toBeUndefined();

    const callsAfterFirst = calls.length;
    const second = await getYouTubeChannelItems(env, 'UCX6OQ3DkcsbYNE6H8uQQuVA', fetcher);
    expect(second.items.map((i) => i.id)).toEqual(['vid1']);
    expect(calls.length).toBe(callsAfterFirst); // served from cache, no new network calls
  });

  it('degrades to stale last-good cache when the API hits quota', async () => {
    let mode: 'ok' | 'quota' = 'ok';
    const fetcher = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (mode === 'quota') return quotaResponse();
      if (u.includes('/channels')) return jsonResponse({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
      return jsonResponse({ items: [{ snippet: { title: 'V', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { videoId: 'good' } }] });
    }) as typeof fetch;

    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    await getYouTubeChannelItems(env, 'UC1', fetcher); // warms fresh + last-good
    // expire the fresh key so the next read re-fetches
    await env.CACHE.delete('yt:channel:UC1');
    mode = 'quota';
    const degraded = await getYouTubeChannelItems(env, 'UC1', fetcher);
    expect(degraded.stale).toBe(true);
    expect(degraded.items.map((i) => i.id)).toEqual(['good']);
  });

  it('returns an error result (not throw) on quota with no cache', async () => {
    const fetcher = (async () => quotaResponse()) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await getYouTubeChannelItems(env, 'UCnone', fetcher);
    expect(out.items).toEqual([]);
    expect(out.error).toBeTruthy();
  });
});

describe('getYouTubeSearchItems', () => {
  it('maps search results', async () => {
    const fetcher = (async () =>
      jsonResponse({ items: [{ id: { videoId: 's1' }, snippet: { title: 'T', publishedAt: '2026-01-01T00:00:00Z' } }] })) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await getYouTubeSearchItems(env, 'cats', fetcher);
    expect(out.items.map((i) => i.id)).toEqual(['s1']);
  });
});

describe('resolveYouTubeChannel', () => {
  it('resolves a handle to channelId + title', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('forHandle=MrBeast');
      return jsonResponse({ items: [{ id: 'UCresolved', snippet: { title: 'MrBeast' } }] });
    }) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    const out = await resolveYouTubeChannel(env, { by: 'handle', handle: 'MrBeast' }, fetcher);
    expect(out).toEqual({ channelId: 'UCresolved', title: 'MrBeast' });
  });
  it('throws when no channel matches', async () => {
    const fetcher = (async () => jsonResponse({ items: [] })) as typeof fetch;
    const env: YouTubeEnv = { YOUTUBE_API_KEY: 'k', CACHE: fakeKV() };
    await expect(resolveYouTubeChannel(env, { by: 'handle', handle: 'nobody' }, fetcher)).rejects.toThrow();
  });
});

it('YouTubeQuotaError is an Error subclass', () => {
  expect(new YouTubeQuotaError('x')).toBeInstanceOf(Error);
});
