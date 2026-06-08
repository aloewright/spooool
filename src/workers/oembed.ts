import { Hono } from 'hono';
import { z } from 'zod';

export interface OembedEnv {
  DB: D1Database;
}

const querySchema = z.object({
  url: z.string().url(),
  format: z.enum(['json']).optional().default('json'),
});

// /embed/:id ships a dedicated frameable player page (relaxed CSP), so oEmbed
// can return type:"video" with an iframe and rich embeds work on Slack/Discord.
const OEMBED_VERSION = '1.0';
const OEMBED_PROVIDER_NAME = 'spooool';
const OEMBED_CACHE_SECONDS = 300;
const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;
const EMBED_WIDTH = 1280;
const EMBED_HEIGHT = 720;

interface VideoRow {
  id: string;
  title: string;
  status: string | null;
  thumbnail_url: string | null;
  channel_name: string | null;
  channel_username: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  deleted_at: string | null;
}

// Pull the watch ID out of a URL when it matches the same host + /watch/:id
// shape the SPA renders. Returns null on any mismatch — wrong host, wrong
// path, multiple segments, malformed percent-encoding, or an embedded slash —
// so we never serve oEmbed for arbitrary pages and never 500 on user input.
export function extractWatchId(rawUrl: string, expectedHost: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.host.toLowerCase() !== expectedHost.toLowerCase()) return null;
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2 || segments[0] !== 'watch') return null;
  let id: string;
  try {
    id = decodeURIComponent(segments[1]);
  } catch {
    // Malformed percent-encoding (e.g. `%E0%A4%A`) would otherwise throw a
    // URIError and surface as a 500 on a public endpoint.
    return null;
  }
  if (id.length === 0 || id.length > 128) return null;
  if (id.includes('/')) return null;
  return id;
}

export interface OembedVideoResponse {
  type: 'video';
  version: '1.0';
  provider_name: string;
  provider_url: string;
  title: string;
  author_name: string;
  author_url: string;
  html: string;
  width: number;
  height: number;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  cache_age: number;
}

export function buildOembedLinkResponse(args: {
  origin: string;
  videoId: string;
  video: Pick<VideoRow, 'title' | 'thumbnail_url' | 'channel_name' | 'channel_username'>;
}): OembedVideoResponse {
  const { origin, videoId, video } = args;
  const authorUrl = video.channel_username
    ? `${origin}/channel/${encodeURIComponent(video.channel_username)}`
    : origin;
  const embedUrl = `${origin}/embed/${encodeURIComponent(videoId)}`;
  const html = `<iframe src="${embedUrl}" width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}" frameborder="0" allowfullscreen allow="autoplay; picture-in-picture"></iframe>`;

  const response: OembedVideoResponse = {
    type: 'video',
    version: OEMBED_VERSION,
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: origin,
    title: video.title,
    author_name: video.channel_name ?? '',
    author_url: authorUrl,
    html,
    width: EMBED_WIDTH,
    height: EMBED_HEIGHT,
    cache_age: OEMBED_CACHE_SECONDS,
  };
  if (video.thumbnail_url) {
    response.thumbnail_url = video.thumbnail_url;
    response.thumbnail_width = THUMBNAIL_WIDTH;
    response.thumbnail_height = THUMBNAIL_HEIGHT;
  }
  return response;
}

export const oembedRoutes = new Hono<{ Bindings: OembedEnv }>();

oembedRoutes.get('/api/oembed', async (c) => {
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { url } = parsed.data;
  const reqUrl = new URL(c.req.url);

  const videoId = extractWatchId(url, reqUrl.host);
  if (!videoId) {
    return c.json({ error: 'URL is not a recognized watch page' }, 404);
  }

  const video = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.status, v.thumbnail_url,
            v.hidden_at, v.dmca_status, v.deleted_at,
            u.name AS channel_name, u.username AS channel_username
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     WHERE v.id = ?`,
  )
    .bind(videoId)
    .first<VideoRow>();

  if (!video || video.deleted_at || video.status !== 'ready') {
    // Don't surface metadata for videos still processing or in an error state.
    return c.json({ error: 'Video not found' }, 404);
  }
  if (video.hidden_at || video.dmca_status === 'disabled') {
    // Hidden / DMCA-disabled videos shouldn't leak metadata to embedders.
    return c.json({ error: 'Video not found' }, 404);
  }

  const body = buildOembedLinkResponse({ origin: reqUrl.origin, videoId, video });
  return c.json(body, 200, {
    'Cache-Control': `public, max-age=${OEMBED_CACHE_SECONDS}`,
  });
});
