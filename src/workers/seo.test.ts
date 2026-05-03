import { describe, expect, it } from 'vitest';
import {
  buildVideoSitemapEntry,
  escapeXml,
  renderRobotsTxt,
  renderSitemap,
  renderSitemapIndex,
  seoRoutes,
  toW3CDate,
  truncateForSitemap,
  videoSitemapPageCount,
  type SeoEnv,
} from './seo';

describe('renderRobotsTxt', () => {
  it('disallows /admin and /api/, exposes the sitemap', () => {
    const out = renderRobotsTxt('https://spooool.com');
    expect(out).toContain('User-agent: *');
    expect(out).toContain('Disallow: /admin');
    expect(out).toContain('Disallow: /api/');
    expect(out).toContain('Allow: /');
    expect(out).toContain('Sitemap: https://spooool.com/sitemap.xml');
  });
});

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;',
    );
  });
});

describe('toW3CDate', () => {
  it('returns undefined for missing values', () => {
    expect(toW3CDate(null)).toBeUndefined();
    expect(toW3CDate(undefined)).toBeUndefined();
    expect(toW3CDate('')).toBeUndefined();
  });

  it('normalizes SQLite CURRENT_TIMESTAMP into W3C UTC', () => {
    expect(toW3CDate('2026-04-30 12:34:56')).toBe('2026-04-30T12:34:56Z');
  });

  it('passes through ISO-8601 timestamps', () => {
    expect(toW3CDate('2026-04-30T12:34:56Z')).toBe('2026-04-30T12:34:56Z');
    expect(toW3CDate('2026-04-30T12:34:56.789Z')).toBe('2026-04-30T12:34:56Z');
  });

  it('returns undefined for unparseable values', () => {
    expect(toW3CDate('not-a-date')).toBeUndefined();
  });
});

describe('renderSitemap', () => {
  it('emits a valid urlset envelope', () => {
    const xml = renderSitemap([{ loc: 'https://spooool.com/' }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://spooool.com/</loc>');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('emits optional lastmod / changefreq / priority when provided', () => {
    const xml = renderSitemap([
      {
        loc: 'https://spooool.com/watch/abc',
        lastmod: '2026-04-30T12:34:56Z',
        changefreq: 'weekly',
        priority: 0.7,
      },
    ]);
    expect(xml).toContain('<lastmod>2026-04-30T12:34:56Z</lastmod>');
    expect(xml).toContain('<changefreq>weekly</changefreq>');
    expect(xml).toContain('<priority>0.7</priority>');
  });

  it('omits optional fields when not provided', () => {
    const xml = renderSitemap([{ loc: 'https://spooool.com/' }]);
    expect(xml).not.toContain('<lastmod>');
    expect(xml).not.toContain('<changefreq>');
    expect(xml).not.toContain('<priority>');
  });

  it('clamps priority into [0, 1] with one decimal', () => {
    const xml = renderSitemap([
      { loc: 'https://x.test/a', priority: 5 },
      { loc: 'https://x.test/b', priority: -2 },
    ]);
    expect(xml).toContain('<priority>1.0</priority>');
    expect(xml).toContain('<priority>0.0</priority>');
  });

  it('escapes XML metacharacters in loc values', () => {
    const xml = renderSitemap([
      { loc: 'https://x.test/?q=a&b=<tag>' },
    ]);
    expect(xml).toContain('<loc>https://x.test/?q=a&amp;b=&lt;tag&gt;</loc>');
  });

  it('omits the xmlns:video namespace when no video metadata is present', () => {
    const xml = renderSitemap([{ loc: 'https://spooool.com/' }]);
    expect(xml).not.toContain('xmlns:video');
  });

  it('declares xmlns:video and emits <video:video> when metadata is present', () => {
    const xml = renderSitemap([
      {
        loc: 'https://spooool.com/watch/abc',
        video: {
          thumbnail_loc: 'https://spooool.com/thumb/abc.jpg',
          title: 'Hello',
          description: 'A short description.',
          content_loc: 'https://spooool.com/api/videos/abc/stream',
        },
      },
    ]);
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain('<video:video>');
    expect(xml).toContain('<video:thumbnail_loc>https://spooool.com/thumb/abc.jpg</video:thumbnail_loc>');
    expect(xml).toContain('<video:title>Hello</video:title>');
    expect(xml).toContain('<video:description>A short description.</video:description>');
    expect(xml).toContain('<video:content_loc>https://spooool.com/api/videos/abc/stream</video:content_loc>');
    expect(xml).toContain('</video:video>');
  });

  it('escapes metacharacters inside <video:video> fields', () => {
    const xml = renderSitemap([
      {
        loc: 'https://x.test/watch/1',
        video: {
          thumbnail_loc: 'https://x.test/t.jpg?a=1&b=2',
          title: '<bad>',
          description: 'a & b',
          content_loc: 'https://x.test/api/videos/1/stream?q=&r',
        },
      },
    ]);
    expect(xml).toContain('<video:title>&lt;bad&gt;</video:title>');
    expect(xml).toContain('<video:description>a &amp; b</video:description>');
    expect(xml).toContain('<video:thumbnail_loc>https://x.test/t.jpg?a=1&amp;b=2</video:thumbnail_loc>');
    expect(xml).toContain(
      '<video:content_loc>https://x.test/api/videos/1/stream?q=&amp;r</video:content_loc>',
    );
  });

  it('truncates over-long titles and descriptions to Google sitemap limits', () => {
    const longTitle = 'a'.repeat(150);
    const longDesc = 'b'.repeat(3000);
    const xml = renderSitemap([
      {
        loc: 'https://x.test/watch/1',
        video: {
          thumbnail_loc: 'https://x.test/t.jpg',
          title: longTitle,
          description: longDesc,
          content_loc: 'https://x.test/api/videos/1/stream',
        },
      },
    ]);
    expect(xml).toContain(`<video:title>${'a'.repeat(100)}</video:title>`);
    expect(xml).toContain(`<video:description>${'b'.repeat(2048)}</video:description>`);
  });
});

describe('truncateForSitemap', () => {
  it('returns the input untouched when shorter than the cap', () => {
    expect(truncateForSitemap('abc', 10)).toBe('abc');
  });

  it('slices to the cap when longer', () => {
    expect(truncateForSitemap('abcdef', 3)).toBe('abc');
  });
});

describe('buildVideoSitemapEntry', () => {
  it('returns undefined when the video has no thumbnail', () => {
    const entry = buildVideoSitemapEntry({
      origin: 'https://x.test',
      row: {
        id: 'v1',
        title: 't',
        description: 'd',
        thumbnail_url: null,
        updated_at: '2026-04-30T00:00:00Z',
      },
    });
    expect(entry).toBeUndefined();
  });

  it('builds an entry pointing content_loc at the API stream route when a thumbnail exists', () => {
    const entry = buildVideoSitemapEntry({
      origin: 'https://x.test',
      row: {
        id: 'v 1',
        title: 't',
        description: 'd',
        thumbnail_url: 'https://x.test/thumb.jpg',
        updated_at: '2026-04-30T00:00:00Z',
      },
    });
    expect(entry).toEqual({
      thumbnail_loc: 'https://x.test/thumb.jpg',
      title: 't',
      description: 'd',
      content_loc: 'https://x.test/api/videos/v%201/stream',
    });
  });
});

describe('seoRoutes — /robots.txt', () => {
  it('serves robots.txt with the request origin', async () => {
    const env: SeoEnv = { DB: {} as D1Database };
    const res = await seoRoutes.request('/robots.txt', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    const body = await res.text();
    expect(body).toContain('Sitemap: http://localhost/sitemap.xml');
  });
});

interface FakePrepared {
  bind: (...values: unknown[]) => FakePrepared;
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
}

interface FakeVideoRow {
  id: string;
  title?: string;
  description?: string;
  thumbnail_url?: string | null;
  updated_at: string;
}

function fakeDB(rows: {
  videos: Array<FakeVideoRow>;
  channels: Array<{ username: string; updated_at: string }>;
  totalVideos?: number;
}): D1Database {
  const stmt = (sql: string): FakePrepared => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const isCount = trimmed.startsWith('SELECT COUNT(*)');
    const isVideos = trimmed.startsWith('SELECT id, title, description, thumbnail_url, updated_at FROM videos');
    let bindArgs: unknown[] = [];
    const api: FakePrepared = {
      bind: (...values: unknown[]) => {
        bindArgs = values;
        return api;
      },
      all: async () => {
        if (isVideos) {
          const [limit, offset] = bindArgs as [number, number];
          if (typeof offset === 'number') {
            return { results: rows.videos.slice(offset, offset + limit) };
          }
          return { results: rows.videos };
        }
        return { results: rows.channels };
      },
      first: async () => {
        if (isCount) return { n: rows.totalVideos ?? rows.videos.length };
        return null;
      },
    };
    return api;
  };
  return { prepare: stmt } as unknown as D1Database;
}

describe('seoRoutes — /sitemap.xml', () => {
  it('lists the home page, search, ready videos, and channels with videos', async () => {
    const env: SeoEnv = {
      DB: fakeDB({
        videos: [
          { id: 'video-1', updated_at: '2026-04-30 11:00:00' },
          { id: 'video & special', updated_at: '2026-04-29 11:00:00' },
        ],
        channels: [{ username: 'alice', updated_at: '2026-04-30 12:00:00' }],
      }),
    };
    const res = await seoRoutes.request('/sitemap.xml', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-control')).toContain('max-age=3600');

    const body = await res.text();
    expect(body).toContain('<loc>http://localhost/</loc>');
    expect(body).toContain('<loc>http://localhost/search</loc>');
    expect(body).toContain('<loc>http://localhost/watch/video-1</loc>');
    // url-encodes path segments to keep the XML well-formed
    expect(body).toContain('<loc>http://localhost/watch/video%20%26%20special</loc>');
    expect(body).toContain('<loc>http://localhost/channel/alice</loc>');
    expect(body).toContain('<lastmod>2026-04-30T11:00:00Z</lastmod>');
  });

  it('still serves a valid sitemap when there are no videos or channels', async () => {
    const env: SeoEnv = { DB: fakeDB({ videos: [], channels: [] }) };
    const res = await seoRoutes.request('/sitemap.xml', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>http://localhost/</loc>');
    expect(body).toContain('<loc>http://localhost/search</loc>');
  });

  it('emits <video:video> entries for videos that have a thumbnail', async () => {
    const env: SeoEnv = {
      DB: fakeDB({
        videos: [
          {
            id: 'v1',
            title: 'Hello world',
            description: 'a description',
            thumbnail_url: 'https://cdn.spooool.com/t/v1.jpg',
            updated_at: '2026-04-30 11:00:00',
          },
          {
            id: 'v2',
            title: 'No thumb',
            description: 'd',
            thumbnail_url: null,
            updated_at: '2026-04-29 10:00:00',
          },
        ],
        channels: [],
      }),
    };
    const res = await seoRoutes.request('/sitemap.xml', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(body).toContain('<video:title>Hello world</video:title>');
    expect(body).toContain('<video:thumbnail_loc>https://cdn.spooool.com/t/v1.jpg</video:thumbnail_loc>');
    expect(body).toContain('<video:content_loc>http://localhost/api/videos/v1/stream</video:content_loc>');
    // v2 has no thumbnail → it appears as a plain <url> entry, not a <video:video>.
    expect(body).toContain('<loc>http://localhost/watch/v2</loc>');
    expect(body).not.toMatch(/<video:title>No thumb<\/video:title>/);
  });
});

describe('renderSitemapIndex', () => {
  it('emits a valid sitemapindex envelope', () => {
    const xml = renderSitemapIndex([{ loc: 'https://x.test/sitemap-videos-1.xml' }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<sitemap>');
    expect(xml).toContain('<loc>https://x.test/sitemap-videos-1.xml</loc>');
    expect(xml.trimEnd().endsWith('</sitemapindex>')).toBe(true);
  });

  it('emits optional <lastmod> when provided', () => {
    const xml = renderSitemapIndex([
      { loc: 'https://x.test/sitemap-videos-1.xml', lastmod: '2026-04-30T12:00:00Z' },
    ]);
    expect(xml).toContain('<lastmod>2026-04-30T12:00:00Z</lastmod>');
  });

  it('escapes XML metacharacters in entry locs', () => {
    const xml = renderSitemapIndex([{ loc: 'https://x.test/?a=1&b=2' }]);
    expect(xml).toContain('<loc>https://x.test/?a=1&amp;b=2</loc>');
  });
});

describe('videoSitemapPageCount', () => {
  it('returns 0 when there are no videos', () => {
    expect(videoSitemapPageCount(0)).toBe(0);
  });

  it('returns 1 when total fits in a single page', () => {
    expect(videoSitemapPageCount(1)).toBe(1);
    expect(videoSitemapPageCount(5000)).toBe(1);
  });

  it('rounds up partial pages', () => {
    expect(videoSitemapPageCount(5001)).toBe(2);
    expect(videoSitemapPageCount(10000)).toBe(2);
    expect(videoSitemapPageCount(10001)).toBe(3);
  });

  it('honors a custom per-page size', () => {
    expect(videoSitemapPageCount(250, 100)).toBe(3);
  });
});

describe('seoRoutes — paginated /sitemap.xml', () => {
  it('returns a single urlset (not an index) when total ≤ page size', async () => {
    const env: SeoEnv = {
      DB: fakeDB({
        videos: [{ id: 'v1', updated_at: '2026-04-30 00:00:00' }],
        channels: [],
        totalVideos: 1,
      }),
    };
    const res = await seoRoutes.request('/sitemap.xml', {}, env);
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).not.toContain('<sitemapindex');
    expect(body).toContain('<loc>http://localhost/watch/v1</loc>');
  });

  it('returns a sitemapindex pointing at static + per-page video files when total exceeds page size', async () => {
    const env: SeoEnv = {
      DB: fakeDB({
        videos: [],
        channels: [],
        totalVideos: 12_345,
      }),
    };
    const res = await seoRoutes.request('/sitemap.xml', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const body = await res.text();
    expect(body).toContain('<sitemapindex');
    expect(body).toContain('<loc>http://localhost/sitemap-static.xml</loc>');
    expect(body).toContain('<loc>http://localhost/sitemap-videos-1.xml</loc>');
    expect(body).toContain('<loc>http://localhost/sitemap-videos-2.xml</loc>');
    expect(body).toContain('<loc>http://localhost/sitemap-videos-3.xml</loc>');
    expect(body).not.toContain('<loc>http://localhost/sitemap-videos-4.xml</loc>');
  });
});

describe('seoRoutes — /sitemap-static.xml', () => {
  it('contains home, search, and channel URLs (no video URLs)', async () => {
    const env: SeoEnv = {
      DB: fakeDB({
        videos: [{ id: 'v1', updated_at: '2026-04-30 00:00:00' }],
        channels: [{ username: 'alice', updated_at: '2026-04-30 12:00:00' }],
      }),
    };
    const res = await seoRoutes.request('/sitemap-static.xml', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<loc>http://localhost/</loc>');
    expect(body).toContain('<loc>http://localhost/search</loc>');
    expect(body).toContain('<loc>http://localhost/channel/alice</loc>');
    expect(body).not.toContain('/watch/v1');
  });
});

describe('seoRoutes — /sitemap-videos-:page.xml (wildcard route)', () => {
  it('serves a urlset of videos for the requested page', async () => {
    const videos = Array.from({ length: 12 }, (_, i) => ({
      id: `v${i + 1}`,
      updated_at: '2026-04-30 00:00:00',
    }));
    const env: SeoEnv = { DB: fakeDB({ videos, channels: [], totalVideos: 12 }) };
    const res = await seoRoutes.request('/sitemap-videos-1.xml', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>http://localhost/watch/v1</loc>');
    expect(body).not.toContain('<loc>http://localhost/</loc>');
    expect(body).not.toContain('<loc>http://localhost/search</loc>');
  });

  it('returns 400 when the page param is non-numeric', async () => {
    const env: SeoEnv = { DB: fakeDB({ videos: [], channels: [], totalVideos: 5 }) };
    const res = await seoRoutes.request('/sitemap-videos-foo.xml', {}, env);
    expect(res.status).toBe(400);
  });

  it('returns 400 for zero / negative pages', async () => {
    const env: SeoEnv = { DB: fakeDB({ videos: [], channels: [], totalVideos: 5 }) };
    expect((await seoRoutes.request('/sitemap-videos-0.xml', {}, env)).status).toBe(400);
  });

  it('returns 404 when page is past the last page', async () => {
    const env: SeoEnv = { DB: fakeDB({ videos: [], channels: [], totalVideos: 5 }) };
    const res = await seoRoutes.request('/sitemap-videos-99.xml', {}, env);
    expect(res.status).toBe(404);
  });
});
