// ALO-158: per-video Open Graph + Twitter card meta tags injected into the
// SPA HTML for /watch/:id.
//
// OG image strategy:
//   - Videos with a thumbnail → use the thumbnail URL directly (works on all platforms).
//   - Videos without a thumbnail → serve a branded SVG card from /api/og/video/:id
//     (works on Twitter/X, LinkedIn, and other SVG-capable crawlers).
//
// SPA injection: worker fetches index.html from the assets binding, runs an
// HTMLRewriter pass that strips any existing site-wide og:* / twitter:*
// tags and inserts per-video tags into <head>. Falls back to the
// untouched HTML on any failure (missing video, bad id, asset hiccup) so
// the SPA still renders even if metadata enrichment misbehaves.

import { Hono } from 'hono';

export interface OgMetaEnv {
  DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

// ─── OG Card Image Generator ──────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Greedy word-wrap for SVG <text> elements. Returns at most `maxLines` lines.
export function wrapSvgText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

// Generates a 1200×630 branded SVG card for sharing when no thumbnail exists.
export function buildOgCardSvg(args: { title: string; channelName?: string | null }): string {
  const FONT = 'system-ui,-apple-system,sans-serif';
  const titleLines = wrapSvgText(args.title || 'Spooool', 26, 2);
  const TITLE_Y = 230;
  const TITLE_LINE_HEIGHT = 82;
  const TITLE_FONT = 64;

  const titleEls = titleLines
    .map(
      (line, i) =>
        `  <text x="72" y="${TITLE_Y + i * TITLE_LINE_HEIGHT}" font-family="${FONT}" font-size="${TITLE_FONT}" font-weight="700" fill="#f1f5f9">${escapeXml(line)}</text>`,
    )
    .join('\n');

  const channelY = TITLE_Y + titleLines.length * TITLE_LINE_HEIGHT + 28;
  const channelEl = args.channelName
    ? `  <text x="72" y="${channelY}" font-family="${FONT}" font-size="32" fill="#a78bfa">${escapeXml(args.channelName)}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">`,
    `  <defs>`,
    `    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `      <stop offset="0%" stop-color="#0c0a1e"/>`,
    `      <stop offset="100%" stop-color="#1e0a3c"/>`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect width="1200" height="630" fill="url(#bg)"/>`,
    `  <rect x="0" y="0" width="8" height="630" fill="#7c3aed"/>`,
    titleEls,
    channelEl,
    `  <text x="72" y="596" font-family="${FONT}" font-size="20" fill="#6b7280" letter-spacing="3">SPOOOOL.COM</text>`,
    `</svg>`,
  ].join('\n');
}

interface VideoMetaRow {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  status: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  deleted_at: string | null;
  channel_name: string | null;
}

const TITLE_MAX = 70;
const DESCRIPTION_MAX = 200;

export function clampForMeta(value: string | null | undefined, max: number): string {
  if (!value) return '';
  // Iterate code points so emoji at the boundary aren't split into lone
  // surrogates (same fix as truncateForSitemap). We deliberately keep the
  // ellipsis ASCII to avoid re-introducing surrogate edges.
  const chars = [...value.trim()];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// Build the meta tag block for a video. Pure function so we can unit-test
// without spinning up a worker harness.
export function buildOgMetaTags(args: {
  origin: string;
  watchUrl: string;
  videoId: string;
  video: Pick<VideoMetaRow, 'title' | 'description' | 'thumbnail_url' | 'channel_name'>;
}): string {
  const { origin, watchUrl, videoId, video } = args;
  const title = clampForMeta(video.title, TITLE_MAX) || 'Spooool';
  const description = clampForMeta(
    video.description ?? `Watch on Spooool${video.channel_name ? ` — ${video.channel_name}` : ''}`,
    DESCRIPTION_MAX,
  );
  // Use the video thumbnail when available (raster, works on all platforms).
  // Fall back to a branded SVG card generated on-the-fly when there is none.
  const image = video.thumbnail_url ?? `${origin}/api/og/video/${encodeURIComponent(videoId)}`;

  const escape = (v: string): string =>
    v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return [
    `<meta property="og:type" content="video.other" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    `<meta property="og:url" content="${escape(watchUrl)}" />`,
    `<meta property="og:image" content="${escape(image)}" />`,
    `<meta property="og:site_name" content="Spooool" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(title)}" />`,
    `<meta name="twitter:description" content="${escape(description)}" />`,
    `<meta name="twitter:image" content="${escape(image)}" />`,
  ].join('\n    ');
}

async function loadVideoMeta(db: D1Database, id: string): Promise<VideoMetaRow | null> {
  return db
    .prepare(
      `SELECT v.id, v.title, v.description, v.thumbnail_url, v.status,
              v.hidden_at, v.dmca_status, v.deleted_at,
              u.name AS channel_name
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ?`,
    )
    .bind(id)
    .first<VideoMetaRow>();
}

export function isPublicViewable(video: VideoMetaRow): boolean {
  if (video.deleted_at) return false;
  if (video.hidden_at) return false;
  if (video.status !== 'ready') return false;
  if (video.dmca_status === 'disabled') return false;
  return true;
}

export const ogMetaRoutes = new Hono<{ Bindings: OgMetaEnv }>();

// /watch/:id — serve the SPA HTML with per-video og:* / twitter:* meta tags.
// Falls back to the untouched asset on any failure path so misbehaviour here
// can't break navigation.
ogMetaRoutes.get('/watch/:id', async (c) => {
  const id = c.req.param('id');

  // Always fetch the asset; even on failure paths we want to return SPA HTML.
  const assetReq = new Request(new URL('/index.html', c.req.url).toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  });
  const assetRes = await c.env.ASSETS.fetch(assetReq);
  if (!assetRes.ok || !assetRes.headers.get('content-type')?.includes('text/html')) {
    return assetRes;
  }

  let video: VideoMetaRow | null = null;
  try {
    if (id && id.length > 0 && id.length <= 128) {
      video = await loadVideoMeta(c.env.DB, id);
    }
  } catch {
    video = null;
  }

  if (!video || !isPublicViewable(video)) {
    return assetRes;
  }

  const origin = new URL(c.req.url).origin;
  const watchUrl = `${origin}/watch/${encodeURIComponent(video.id)}`;
  const tags = buildOgMetaTags({ origin, watchUrl, videoId: video.id, video });

  // Strip any pre-existing og:* / twitter:* meta from the static HTML so we
  // don't emit duplicates. Then inject the per-video tags before </head>.
  const rewriter = new HTMLRewriter()
    .on('meta[property^="og:"], meta[name^="twitter:"]', {
      element(el) {
        el.remove();
      },
    })
    .on('head', {
      element(el) {
        el.append(`\n    ${tags}\n  `, { html: true });
      },
    });

  return rewriter.transform(assetRes);
});

// /api/og/video/:id — branded SVG card for videos that have no thumbnail.
// Used as the og:image fallback so sharers always get a usable preview image
// rather than the generic site icon. Cached at the edge for 24 h.
ogMetaRoutes.get('/api/og/video/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 128) return c.text('Not found', 404);

  let title = 'Spooool';
  let channelName: string | null = null;

  try {
    const row = await c.env.DB.prepare(
      `SELECT v.title, u.name AS channel_name
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
      .bind(id)
      .first<{ title: string; channel_name: string | null }>();
    if (row) {
      title = row.title;
      channelName = row.channel_name;
    }
  } catch {
    // Serve generic branded card on any DB error.
  }

  const svg = buildOgCardSvg({ title, channelName });
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
  });
});
