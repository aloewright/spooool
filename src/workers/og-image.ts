// GET /og/:videoId.png — OG image generation for social sharing cards.
//
// Serves a 1200×630 image for each public video:
//   1. If the video has a thumbnail_url: proxy it through Cloudflare Image
//      Resizing (cf.image) to get a properly-cropped JPEG at social-card
//      dimensions. Serves from our domain so it's cacheable and purgeable.
//   2. Fallback: an SVG card with the video title and channel name overlaid
//      on a branded gradient background — no external dependencies.
//
// Cache headers: 1-hour browser TTL, 24-hour CDN TTL with 7-day SWR so
// re-encodes/thumbnail changes propagate quickly but the common path is cheap.

import { Hono } from 'hono';
import type { VideoMetaRow } from './og-meta';
import { isPublicViewable, clampForMeta } from './og-meta';

export interface OgImageEnv {
  DB: D1Database;
}

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const TITLE_SVG_MAX = 55;
const CHANNEL_SVG_MAX = 45;

const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

function escSvg(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapSvgText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + (current ? ' ' : '') + word).length > maxCharsPerLine) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
    if (lines.length >= 3) break;
  }
  if (current && lines.length < 3) lines.push(current);
  return lines;
}

export function buildFallbackSvg(title: string, channelName: string | null): string {
  const titleText = clampForMeta(title, 120) || 'Spooool';
  const titleLines = wrapSvgText(titleText, TITLE_SVG_MAX);
  const channelText = channelName ? clampForMeta(channelName, CHANNEL_SVG_MAX) : null;

  const titleLineHeight = 76;
  const titleStartY = channelText
    ? Math.max(160, 260 - titleLines.length * (titleLineHeight / 2))
    : Math.max(200, 315 - titleLines.length * (titleLineHeight / 2));

  const titleSvg = titleLines
    .map(
      (line, i) =>
        `<text x="60" y="${titleStartY + i * titleLineHeight}" ` +
        `font-family="system-ui,-apple-system,sans-serif" font-size="64" font-weight="700" ` +
        `fill="white">${escSvg(line)}</text>`,
    )
    .join('\n  ');

  const channelY = titleStartY + titleLines.length * titleLineHeight + 32;
  const channelSvg = channelText
    ? `<text x="60" y="${channelY}" ` +
      `font-family="system-ui,-apple-system,sans-serif" font-size="36" fill="#9ca3af">${escSvg(channelText)}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">`,
    `  <defs>`,
    `    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `      <stop offset="0%" stop-color="#0f0f13"/>`,
    `      <stop offset="100%" stop-color="#1c0a35"/>`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)"/>`,
    `  <rect x="0" y="0" width="8" height="${OG_HEIGHT}" fill="#7c3aed"/>`,
    `  ${titleSvg}`,
    `  ${channelSvg}`,
    `  <text x="60" y="${OG_HEIGHT - 40}" font-family="system-ui,-apple-system,sans-serif" font-size="28" fill="#4b5563">spooool.com</text>`,
    `</svg>`,
  ].join('\n');
}

export const ogImageRoutes = new Hono<{ Bindings: OgImageEnv }>();

ogImageRoutes.get('/og/:videoId.png', async (c) => {
  const videoId = c.req.param('videoId');
  if (!videoId || videoId.length > 128) return c.text('Not found', 404);

  let video: VideoMetaRow | null = null;
  try {
    video = await c.env.DB.prepare(
      `SELECT v.id, v.title, v.description, v.thumbnail_url, v.status,
              v.hidden_at, v.dmca_status, v.deleted_at,
              u.name AS channel_name
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ?`,
    )
      .bind(videoId)
      .first<VideoMetaRow>();
  } catch {
    return c.text('Not found', 404);
  }

  if (!video || !isPublicViewable(video)) return c.text('Not found', 404);

  if (video.thumbnail_url) {
    try {
      // Use Cloudflare Image Resizing to crop/resize to 1200×630 JPEG.
      // The `cf.image` option is a CF Workers runtime extension; it falls
      // back silently to a plain fetch in environments where Image Resizing
      // is not enabled (local dev, unentitled zones).
      const res = await fetch(video.thumbnail_url, {
        cf: {
          image: {
            width: OG_WIDTH,
            height: OG_HEIGHT,
            fit: 'cover',
            format: 'jpeg',
            quality: 85,
          },
        },
      });

      if (res.ok) {
        return new Response(res.body, {
          headers: {
            'Content-Type': res.headers.get('Content-Type') ?? 'image/jpeg',
            'Cache-Control': CACHE_CONTROL,
          },
        });
      }
    } catch {
      // Fall through to SVG fallback
    }
  }

  const svg = buildFallbackSvg(video.title, video.channel_name);
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
    },
  });
});
