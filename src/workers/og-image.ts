// ALO-E5: Dynamic OG card image for social sharing.
//
// Generates a branded 1200×630 SVG card per video.  The card uses the video's
// existing thumbnail as background (when available) with a gradient overlay
// and title/channel text rendered on top.  This is returned as
// image/svg+xml — accepted by Discord, Slack, Telegram, WhatsApp, LinkedIn,
// and iMessage.  For Twitter/X and Facebook (which require JPEG/PNG), the
// og:image is still set to the raw thumbnail URL in og-meta.ts so those
// platforms always see a real raster image; the SVG endpoint acts as the
// fallback only when no thumbnail exists.
//
// Responses are cache-controlled at 1 hour so the edge CDN serves them
// without hitting D1 on every social crawler.

import { Hono } from 'hono';
import { edgeCache } from './edge-cache';

export interface OgImageEnv {
  DB: D1Database;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Word-wrap `text` into at most `maxLines` lines, each at most `maxChars`
// characters wide (approximating a proportional font at ~52px).
function wrapTitle(text: string, maxLines: number, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (lines.length >= maxLines) {
        // Truncate: replace last line's tail with ellipsis.
        lines[maxLines - 1] =
          lines[maxLines - 1].slice(0, maxChars - 1) + '…';
        return lines;
      }
      current = word.length > maxChars ? word.slice(0, maxChars - 1) + '…' : word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

export function buildOgImageSvg(video: {
  title: string;
  channel_name: string | null;
  thumbnail_url: string | null;
}): string {
  const W = 1200;
  const H = 630;

  const title = (video.title || 'Untitled').trim();
  const channel = (video.channel_name || 'Spooool').trim();
  const titleLines = wrapTitle(title, 3, 30);

  // Layout: text block sits above the bottom edge with ~60 px gutters.
  const LINE_H = 58;
  const BLOCK_Y = H - 60 - titleLines.length * LINE_H;

  const titleSvg = titleLines
    .map(
      (line, i) =>
        `<text x="60" y="${BLOCK_Y + i * LINE_H}" ` +
        `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" ` +
        `font-size="52" font-weight="700" fill="white" ` +
        `text-rendering="optimizeLegibility">${escapeXml(line)}</text>`,
    )
    .join('\n      ');

  const thumbnailEl = video.thumbnail_url
    ? `<image href="${escapeXml(video.thumbnail_url)}" x="0" y="0" ` +
      `width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="${W}" height="${H}" fill="#12121e"/>` +
      `<text x="${W / 2}" y="${H / 2 - 20}" font-size="110" text-anchor="middle" ` +
      `font-family="serif" fill="#2a2a4a">▶</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#0a0a0a"/>
    ${thumbnailEl}
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="rgba(0,0,0,0)"/>
        <stop offset="40%"  stop-color="rgba(0,0,0,0.35)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.93)"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#scrim)"/>
    ${titleSvg}
    <text x="60" y="${H - 22}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
          font-size="26" fill="rgba(255,255,255,0.60)">
      ${escapeXml(channel)} · spooool.io
    </text>
  </svg>`;
}

export const ogImageRoutes = new Hono<{ Bindings: OgImageEnv }>();

ogImageRoutes.get(
  '/api/og-image/:videoId',
  edgeCache({ ttl: 3600 }),
  async (c) => {
    const videoId = c.req.param('videoId');

    const video = await c.env.DB.prepare(
      `SELECT v.title, v.thumbnail_url, u.name AS channel_name
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
      .bind(videoId)
      .first<{ title: string; thumbnail_url: string | null; channel_name: string | null }>();

    const svg = buildOgImageSvg(
      video ?? { title: 'Spooool', channel_name: null, thumbnail_url: null },
    );

    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
