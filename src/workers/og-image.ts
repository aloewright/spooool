// ALO-E5: dedicated OG image endpoint. For videos with a thumbnail the
// handler issues a 302 to the thumbnail (crawlers follow redirects; this
// keeps the image in raster format which every social platform supports).
// When there is no thumbnail a branded SVG card is returned instead — SVG
// og:image works on Twitter/X, Discord, Slack, WhatsApp, and Telegram.

import { Hono } from 'hono';

export interface OgImageEnv {
  DB: D1Database;
}

interface VideoRow {
  title: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  deleted_at: string | null;
  hidden_at: string | null;
}

// Rough word-wrap: split text into lines that fit ~maxChars characters,
// capping at maxLines. Appends an ellipsis when content is truncated.
function breakLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
  }
  if (current && lines.length < maxLines) {
    // Append ellipsis when there are still unused words
    const allUsed = (lines.join(' ') + ' ' + current).replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim();
    lines.push(current + (allUsed ? '' : '…'));
  }
  return lines;
}

function escSvg(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSvgCard(title: string, channelName: string | null): string {
  // 1200×630 is the canonical OG image size (1.91:1 aspect ratio).
  const W = 1200;
  const H = 630;
  const MARGIN = 64;
  const safeWidth = W - MARGIN * 2; // ~1072 chars worth of layout

  // Font sizes mapped to line count so long titles still fit.
  const lines = breakLines(title, 28, 3);
  const fontSize = lines.length === 1 ? 72 : lines.length === 2 ? 60 : 48;
  const lineHeight = fontSize + 14;

  const blockHeight = lines.length * lineHeight;
  // Vertically centre the title block in the top 80% of the card.
  const titleBaseY = Math.round((H * 0.8 - blockHeight) / 2) + fontSize;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${MARGIN}" dy="${i === 0 ? 0 : lineHeight}">${escSvg(line)}</tspan>`,
    )
    .join('');

  const channel = escSvg(channelName ?? 'Spooool');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0c0c14"/>
      <stop offset="100%" stop-color="#1a0d30"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient>
    <clipPath id="clip">
      <rect width="${W}" height="${H}"/>
    </clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- subtle grid texture -->
  <path d="M0 0 L${W} 0 M0 ${Math.round(H / 3)} L${W} ${Math.round(H / 3)} M0 ${Math.round((H * 2) / 3)} L${W} ${Math.round((H * 2) / 3)}" stroke="#ffffff" stroke-opacity="0.03" stroke-width="1"/>
  <path d="M${Math.round(W / 3)} 0 L${Math.round(W / 3)} ${H} M${Math.round((W * 2) / 3)} 0 L${Math.round((W * 2) / 3)} ${H}" stroke="#ffffff" stroke-opacity="0.03" stroke-width="1"/>

  <!-- left accent bar -->
  <rect x="0" y="0" width="6" height="${H}" fill="url(#accent)"/>

  <!-- title -->
  <text
    x="${MARGIN}" y="${titleBaseY}"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
    font-size="${fontSize}"
    font-weight="700"
    fill="#f9fafb"
    clip-path="url(#clip)"
  >${tspans}</text>

  <!-- bottom strip -->
  <rect x="0" y="${H - 72}" width="${W}" height="72" fill="#000000" fill-opacity="0.35"/>

  <!-- channel name -->
  <text
    x="${MARGIN}" y="${H - 26}"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
    font-size="24"
    fill="#9ca3af"
  >${channel}</text>

  <!-- brand -->
  <text
    x="${W - MARGIN}" y="${H - 26}"
    text-anchor="end"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
    font-size="22"
    font-weight="600"
    fill="#6d28d9"
  >spooool</text>
</svg>`;
}

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=3600, immutable';

export const ogImageRoutes = new Hono<{ Bindings: OgImageEnv }>();

ogImageRoutes.get('/api/og/:videoId', async (c) => {
  const videoId = c.req.param('videoId');
  if (!videoId || videoId.length > 128) return c.notFound();

  let video: VideoRow | null = null;
  try {
    video = await c.env.DB.prepare(
      `SELECT v.title, v.thumbnail_url, v.deleted_at, v.hidden_at,
              u.name AS channel_name
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ?`,
    )
      .bind(videoId)
      .first<VideoRow>();
  } catch {
    return c.notFound();
  }

  if (!video || video.deleted_at || video.hidden_at) return c.notFound();

  // Raster thumbnail: redirect so crawlers get a real image format (JPEG/PNG).
  if (video.thumbnail_url) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: video.thumbnail_url,
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  // No thumbnail: return a branded SVG card.
  return new Response(buildSvgCard(video.title, video.channel_name), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
    },
  });
});
