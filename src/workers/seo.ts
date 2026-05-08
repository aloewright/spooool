import { Hono } from 'hono';

export interface SeoEnv {
  DB: D1Database;
}

export interface VideoSitemapEntry {
  thumbnail_loc: string;
  title: string;
  description: string;
  content_loc: string;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
  video?: VideoSitemapEntry;
}

// Videos per sitemap page. The sitemap protocol caps a urlset at 50,000 URLs
// and 50 MB; 5,000 keeps each file small enough that crawlers can fetch it
// quickly while still covering ~99% of catalogs in a single sitemap.
const VIDEOS_PER_SITEMAP_PAGE = 5000;
const MAX_CHANNEL_URLS = 1000;
const SITEMAP_CACHE_SECONDS = 3600;
const ROBOTS_CACHE_SECONDS = 86400;
// Google video sitemap limits: title <=100 chars, description <=2048 chars.
// https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps
const VIDEO_TITLE_MAX = 100;
const VIDEO_DESCRIPTION_MAX = 2048;

export function renderRobotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    // /api/oembed is a public discovery endpoint — keep it crawlable so
    // link unfurlers that respect robots.txt aren't blocked by the broader
    // /api/ disallow.
    'Allow: /api/oembed',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /account',
    'Disallow: /upload',
    'Disallow: /login',
    'Disallow: /signup',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" UTC. Convert to W3C
// (YYYY-MM-DDTHH:MM:SSZ). Returns undefined if the value isn't parseable so
// the caller can omit <lastmod> rather than emit a malformed date.
export function toW3CDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZ = /Z|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(withZ);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function truncateForSitemap(value: string, max: number): string {
  // Iterate code points so a supplementary character (emoji, CJK extension,
  // etc.) at the boundary doesn't get severed into a lone surrogate. Lone
  // surrogates are forbidden in XML 1.0/1.1 and would invalidate the sitemap.
  const chars = [...value];
  if (chars.length <= max) return value;
  return chars.slice(0, max).join('');
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string;
}

export function renderSitemapIndex(entries: SitemapIndexEntry[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const e of entries) {
    lines.push('  <sitemap>');
    lines.push(`    <loc>${escapeXml(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
    lines.push('  </sitemap>');
  }
  lines.push('</sitemapindex>');
  lines.push('');
  return lines.join('\n');
}

export function videoSitemapPageCount(total: number, perPage: number = VIDEOS_PER_SITEMAP_PAGE): number {
  if (total <= 0) return 0;
  return Math.ceil(total / perPage);
}

export function renderSitemap(urls: SitemapUrl[]): string {
  const hasVideo = urls.some((u) => u.video);
  const urlsetAttrs = hasVideo
    ? ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' +
      ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'
    : ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset${urlsetAttrs}>`,
  ];
  for (const u of urls) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(u.loc)}</loc>`);
    if (u.lastmod) lines.push(`    <lastmod>${escapeXml(u.lastmod)}</lastmod>`);
    if (u.changefreq) lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
    if (typeof u.priority === 'number') {
      const clamped = Math.max(0, Math.min(1, u.priority));
      lines.push(`    <priority>${clamped.toFixed(1)}</priority>`);
    }
    if (u.video) {
      lines.push('    <video:video>');
      lines.push(`      <video:thumbnail_loc>${escapeXml(u.video.thumbnail_loc)}</video:thumbnail_loc>`);
      lines.push(`      <video:title>${escapeXml(truncateForSitemap(u.video.title, VIDEO_TITLE_MAX))}</video:title>`);
      lines.push(
        `      <video:description>${escapeXml(truncateForSitemap(u.video.description, VIDEO_DESCRIPTION_MAX))}</video:description>`,
      );
      lines.push(`      <video:content_loc>${escapeXml(u.video.content_loc)}</video:content_loc>`);
      lines.push('    </video:video>');
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  lines.push('');
  return lines.join('\n');
}

export const seoRoutes = new Hono<{ Bindings: SeoEnv }>();

seoRoutes.get('/robots.txt', (c) => {
  const origin = new URL(c.req.url).origin;
  return new Response(renderRobotsTxt(origin), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${ROBOTS_CACHE_SECONDS}`,
    },
  });
});

interface SitemapVideoRow {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  updated_at: string;
}

export function buildVideoSitemapEntry(args: {
  origin: string;
  row: SitemapVideoRow;
}): VideoSitemapEntry | undefined {
  const { origin, row } = args;
  if (!row.thumbnail_url) return undefined;
  // content_loc must point to the actual media bytes. The /api/videos/:id/stream
  // route serves the R2 object directly with Range support, which Google accepts.
  return {
    thumbnail_loc: row.thumbnail_url,
    title: row.title,
    description: row.description ?? '',
    content_loc: `${origin}/api/videos/${encodeURIComponent(row.id)}/stream`,
  };
}

async function loadVideoPage(db: D1Database, page: number): Promise<SitemapVideoRow[]> {
  const offset = (page - 1) * VIDEOS_PER_SITEMAP_PAGE;
  const result = await db
    .prepare(
      `SELECT id, title, description, thumbnail_url, updated_at FROM videos
       WHERE deleted_at IS NULL AND hidden_at IS NULL AND status = 'ready'
         AND (dmca_status IS NULL OR dmca_status != 'disabled')
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(VIDEOS_PER_SITEMAP_PAGE, offset)
    .all<SitemapVideoRow>();
  return result.results ?? [];
}

async function loadChannelRows(db: D1Database): Promise<{ username: string; updated_at: string }[]> {
  const result = await db
    .prepare(
      `SELECT u.username AS username, MAX(v.updated_at) AS updated_at
       FROM user u
       JOIN videos v ON v.user_id = u.id
       WHERE u.username IS NOT NULL
         AND v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.status = 'ready'
         AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
       GROUP BY u.username
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(MAX_CHANNEL_URLS)
    .all<{ username: string; updated_at: string }>();
  return result.results ?? [];
}

async function countReadyVideos(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM videos
       WHERE deleted_at IS NULL AND hidden_at IS NULL AND status = 'ready'
         AND (dmca_status IS NULL OR dmca_status != 'disabled')`,
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// Catalog-wide lastmod for the sitemap index. Adding any new video bumps
// MAX(updated_at), which shifts every page's contents (page 1 grows, the
// tail spills into page 2, etc.), so a single shared value is honest:
// "if this changed, every page may have changed."
async function loadCatalogLastMod(db: D1Database): Promise<string | undefined> {
  const row = await db
    .prepare(
      `SELECT MAX(updated_at) AS lastmod FROM videos
       WHERE deleted_at IS NULL AND hidden_at IS NULL AND status = 'ready'
         AND (dmca_status IS NULL OR dmca_status != 'disabled')`,
    )
    .first<{ lastmod: string | null }>();
  return toW3CDate(row?.lastmod ?? null);
}

// ALO-183: keep this list in sync with the ARTICLES catalog in
// src/frontend/pages/Help.tsx. Hard-coded here to avoid pulling the React
// module graph into the SEO worker bundle.
const HELP_ARTICLE_SLUGS = ['quickstart', 'upload-guide', 'encoding-tips', 'monetization-faq'] as const;

function buildStaticUrls(origin: string, channelRows: { username: string; updated_at: string }[]): SitemapUrl[] {
  const urls: SitemapUrl[] = [
    { loc: `${origin}/`, changefreq: 'hourly', priority: 1.0 },
    { loc: `${origin}/search`, changefreq: 'daily', priority: 0.8 },
    { loc: `${origin}/help`, changefreq: 'weekly', priority: 0.5 },
  ];
  for (const slug of HELP_ARTICLE_SLUGS) {
    urls.push({
      loc: `${origin}/help/${slug}`,
      changefreq: 'weekly',
      priority: 0.4,
    });
  }
  for (const row of channelRows) {
    urls.push({
      loc: `${origin}/channel/${encodeURIComponent(row.username)}`,
      lastmod: toW3CDate(row.updated_at),
      changefreq: 'daily',
      priority: 0.6,
    });
  }
  return urls;
}

function buildVideoUrls(origin: string, videoRows: SitemapVideoRow[]): SitemapUrl[] {
  return videoRows.map((row) => ({
    loc: `${origin}/watch/${encodeURIComponent(row.id)}`,
    lastmod: toW3CDate(row.updated_at),
    changefreq: 'weekly' as const,
    priority: 0.7,
    video: buildVideoSitemapEntry({ origin, row }),
  }));
}

const sitemapResponse = (xml: string): Response =>
  new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${SITEMAP_CACHE_SECONDS}`,
    },
  });

seoRoutes.get('/sitemap.xml', async (c) => {
  const origin = new URL(c.req.url).origin;
  const total = await countReadyVideos(c.env.DB);

  // Single-page (legacy) layout — keeps small catalogs in one fetch.
  if (total <= VIDEOS_PER_SITEMAP_PAGE) {
    const [videoRows, channelRows] = await Promise.all([
      loadVideoPage(c.env.DB, 1),
      loadChannelRows(c.env.DB),
    ]);
    return sitemapResponse(
      renderSitemap([...buildStaticUrls(origin, channelRows), ...buildVideoUrls(origin, videoRows)]),
    );
  }

  // Paginated layout — emit a sitemap index. Crawlers fetch each child.
  const pages = videoSitemapPageCount(total);
  const lastmod = await loadCatalogLastMod(c.env.DB);
  const entries: SitemapIndexEntry[] = [{ loc: `${origin}/sitemap-static.xml`, lastmod }];
  for (let i = 1; i <= pages; i++) {
    entries.push({ loc: `${origin}/sitemap-videos-${i}.xml`, lastmod });
  }
  return sitemapResponse(renderSitemapIndex(entries));
});

seoRoutes.get('/sitemap-static.xml', async (c) => {
  const origin = new URL(c.req.url).origin;
  const channelRows = await loadChannelRows(c.env.DB);
  return sitemapResponse(renderSitemap(buildStaticUrls(origin, channelRows)));
});

// Hono's `:param` matcher (and its `{regex}` constraint) doesn't reliably
// distinguish a literal `.xml` suffix on the same path segment, so we extract
// the page number from `c.req.path` directly. Wildcard route guarantees the
// handler runs for any /sitemap-videos-* path so we can return a precise 400.
const SITEMAP_VIDEOS_PATTERN = /^\/sitemap-videos-([1-9]\d*)\.xml$/;

seoRoutes.get('/sitemap-videos-*', async (c) => {
  const origin = new URL(c.req.url).origin;
  const match = SITEMAP_VIDEOS_PATTERN.exec(new URL(c.req.url).pathname);
  if (!match) return c.json({ error: 'Invalid page' }, 400);
  const page = Number.parseInt(match[1], 10);
  const total = await countReadyVideos(c.env.DB);
  const pages = videoSitemapPageCount(total);
  if (page > pages) {
    return c.json({ error: 'Page out of range' }, 404);
  }
  const videoRows = await loadVideoPage(c.env.DB, page);
  return sitemapResponse(renderSitemap(buildVideoUrls(origin, videoRows)));
});
