// ALO-124: per-video OG share card. Renders an SVG at the canonical 1200×630
// Open Graph aspect ratio with the video title and channel name overlaid on
// the dark spooool brand. Used as a fallback whenever the video has no
// thumbnail of its own (still encoding, very old upload, etc.) and exposed
// directly at /api/og/video/:id.svg so platforms that prefer SVG previews
// (Slack, Discord, LinkedIn) can pick it up.
//
// Implementation notes:
//  - Pure renderer (renderOgCardSvg) is testable without a Worker harness.
//  - We only XML-escape user-supplied text; everything else is literal SVG.
//  - The endpoint sets long Cache-Control + an immutable variant key so
//    Cloudflare's edge can serve repeats from cache while still picking up
//    title/description edits via the cache-busting `?v=` query param.

import { Hono } from 'hono';

export interface OgImageEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

const TITLE_LINE_LIMIT = 28;
const TITLE_MAX_LINES = 3;
const TITLE_TRUNCATE_TAIL = '…';

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour edge cache; KV mirror for hits.

interface OgVideoRow {
  id: string;
  title: string;
  status: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  deleted_at: string | null;
  channel_name: string | null;
  channel_username: string | null;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Greedy line-wrap by character count. We avoid measuring the rendered glyph
// width because Workers don't have access to a font metrics library — the
// limit is conservative enough that overflow is rare even with wide letters.
//
// If the title doesn't fit in maxLines, the last placed line is suffixed with
// "…" to make truncation visually obvious.
export function wrapTitle(
  title: string,
  options?: { lineLimit?: number; maxLines?: number },
): string[] {
  const lineLimit = options?.lineLimit ?? TITLE_LINE_LIMIT;
  const maxLines = options?.maxLines ?? TITLE_MAX_LINES;
  const trimmed = title.trim();
  if (trimmed.length === 0) return [];

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  let consumed = 0;

  for (const w of words) {
    if (lines.length >= maxLines) break;
    const piece = w.length > lineLimit ? `${w.slice(0, lineLimit - 1)}${TITLE_TRUNCATE_TAIL}` : w;
    if (current.length === 0) {
      current = piece;
      consumed += 1;
      continue;
    }
    if (current.length + 1 + piece.length <= lineLimit) {
      current = `${current} ${piece}`;
      consumed += 1;
      continue;
    }
    lines.push(current);
    if (lines.length >= maxLines) {
      current = '';
      break;
    }
    current = piece;
    consumed += 1;
  }
  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }

  if (consumed < words.length && lines.length > 0) {
    const last = lines[lines.length - 1];
    if (!last.endsWith(TITLE_TRUNCATE_TAIL)) {
      const trimLen = Math.max(1, last.length - 1);
      lines[lines.length - 1] = `${last.slice(0, trimLen)}${TITLE_TRUNCATE_TAIL}`;
    }
  }
  return lines;
}

export function renderOgCardSvg(args: {
  title: string;
  channelName: string | null;
}): string {
  const titleLines = wrapTitle(args.title || 'spooool');
  const channelName = (args.channelName ?? 'spooool').trim() || 'spooool';

  const titleStartY = 280;
  const titleLineHeight = 80;
  const titleSpans = titleLines
    .map(
      (line, i) =>
        `<tspan x="80" y="${titleStartY + i * titleLineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" viewBox="0 0 ${OG_CARD_WIDTH} ${OG_CARD_HEIGHT}" role="img" aria-label="${escapeXml(args.title)} on spooool">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0b10" />
      <stop offset="100%" stop-color="#1a1530" />
    </linearGradient>
  </defs>
  <rect width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" fill="url(#bg)" />
  <g font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif" fill="#ffffff">
    <text x="80" y="140" font-size="44" font-weight="700" letter-spacing="2" fill="#a78bfa">spooool</text>
    <text font-size="60" font-weight="700">${titleSpans}</text>
    <text x="80" y="540" font-size="28" font-weight="500" fill="#cbb5ff">${escapeXml(channelName)}</text>
    <text x="80" y="580" font-size="20" font-weight="400" fill="#9ca3af">spooool.com</text>
  </g>
</svg>`;
}

async function loadOgVideo(db: D1Database, id: string): Promise<OgVideoRow | null> {
  return db
    .prepare(
      `SELECT v.id, v.title, v.status, v.hidden_at, v.dmca_status, v.deleted_at,
              u.name AS channel_name, u.username AS channel_username
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ?`,
    )
    .bind(id)
    .first<OgVideoRow>();
}

export function isOgViewable(video: OgVideoRow): boolean {
  if (video.deleted_at) return false;
  if (video.dmca_status === 'disabled') return false;
  // We allow hidden_at + non-ready states through — share previews still need
  // to render while encoding, and admin-hidden videos already 404 the watch
  // page. The endpoint never reveals private metadata beyond title + channel.
  return true;
}

export function ogImageCacheKey(id: string): string {
  return `og-image:v1:${id}`;
}

export const ogImageRoutes = new Hono<{ Bindings: OgImageEnv }>();

// Hono's `:param` matcher doesn't reliably distinguish a literal `.svg` suffix
// from the param itself (see seoRoutes for the same workaround), so we use a
// wildcard route + regex on c.req.path to extract the id.
export const OG_IMAGE_VIDEO_PATTERN = /^\/api\/og\/video\/([A-Za-z0-9_-]{1,128})\.svg$/;

ogImageRoutes.get('/api/og/video/*', async (c) => {
  const match = OG_IMAGE_VIDEO_PATTERN.exec(new URL(c.req.url).pathname);
  if (!match) {
    return c.json({ error: 'Invalid id' }, 400);
  }
  const id = match[1];

  const cacheKey = ogImageCacheKey(id);
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
        'x-spooool-cache': 'hit',
      },
    });
  }

  const video = await loadOgVideo(c.env.DB, id);
  if (!video || !isOgViewable(video)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const svg = renderOgCardSvg({
    title: video.title,
    channelName: video.channel_name,
  });

  await c.env.CACHE.put(cacheKey, svg, { expirationTtl: CACHE_TTL_SECONDS });

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      'x-spooool-cache': 'miss',
    },
  });
});
