// ALO-158: per-video Open Graph + Twitter card meta tags injected into the
// SPA HTML for /watch/:id. We don't render a custom card image — the video's
// existing thumbnail is the right preview surface, and serving it directly
// avoids a round-trip through ImageResponse / Browser Rendering for the
// common case. (A title-overlay variant can be a follow-up if/when needed.)
//
// Strategy: worker fetches index.html from the assets binding, runs an
// HTMLRewriter pass that strips any existing site-wide og:* / twitter:*
// tags and inserts per-video tags into <head>. Falls back to the
// untouched HTML on any failure (missing video, bad id, asset hiccup) so
// the SPA still renders even if metadata enrichment misbehaves.

import { Hono } from 'hono';

export interface OgMetaEnv {
  DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
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
  const { origin, watchUrl, video } = args;
  const title = clampForMeta(video.title, TITLE_MAX) || 'Spooool';
  const description = clampForMeta(
    video.description ?? `Watch on Spooool${video.channel_name ? ` — ${video.channel_name}` : ''}`,
    DESCRIPTION_MAX,
  );
  // ALO-124: when a video has no thumbnail (still encoding, very old upload,
  // or thumbnail generation failed) fall back to the dynamic OG card endpoint
  // instead of the static /icon.png so social previews still surface the
  // video's title + channel.
  const image =
    video.thumbnail_url ??
    `${origin}/api/og/video/${encodeURIComponent(args.videoId)}.svg`;

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
