// ALO-136: serve the R2-hosted HLS variants produced by the FFmpeg
// fallback encoder. Cloudflare Stream serves its own URLs (videodelivery.net)
// — this route is exclusively for videos transcoded by the local-encoding
// path, where `videos.playback_hls_path` is set to the master playlist's
// R2 key (e.g. `<userId>/<videoId>/hls/master.m3u8`).
//
// The route accepts any sub-path under `/api/videos/:id/hls/` and resolves
// it against the stored prefix, so the HLS player can fetch the master
// playlist, variant playlists, and individual `.ts` segments through the
// same origin without us pre-signing every URL.

import { Hono } from 'hono';

type SessionUser = { id: string } | null;

export interface HlsServeEnv {
  DB: D1Database;
  VIDEOS: R2Bucket;
}

export interface HlsServeVariables {
  user: SessionUser;
}

// Map a manifest file extension to the right Content-Type so the player
// stack (hls.js, native Safari) doesn't have to sniff. Anything else falls
// through to whatever R2 stored on the upload.
const MIME_BY_EXT: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  vtt: 'text/vtt',
  key: 'application/octet-stream',
};

export function contentTypeForHlsAsset(path: string, fallback: string | null): string {
  const dot = path.lastIndexOf('.');
  if (dot >= 0) {
    const ext = path.slice(dot + 1).toLowerCase();
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  }
  return fallback ?? 'application/octet-stream';
}

// Build the absolute R2 key for an HLS sub-path. Disallows `..` so a crafted
// request like `/api/videos/:id/hls/../../other-user/secret.mp4` cannot
// escape the per-video prefix.
export function resolveHlsKey(prefix: string, subPath: string): string | null {
  const cleaned = subPath.replace(/^\/+/, '');
  if (cleaned.length === 0) return null;
  if (cleaned.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  // Ensure the prefix ends with a slash; the webhook stores the full
  // master.m3u8 key, so strip the trailing file name to recover the prefix.
  const slash = prefix.lastIndexOf('/');
  const dirPrefix = slash >= 0 ? prefix.slice(0, slash + 1) : `${prefix}/`;
  return `${dirPrefix}${cleaned}`;
}

export const hlsRoutes = new Hono<{
  Bindings: HlsServeEnv;
  Variables: HlsServeVariables;
}>();

hlsRoutes.on(['GET', 'HEAD'], '/api/videos/:id/hls/*', async (c) => {
  const videoId = c.req.param('id');
  const url = new URL(c.req.url);
  const prefix = `/api/videos/${videoId}/hls/`;
  if (!url.pathname.startsWith(prefix)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const subPath = url.pathname.slice(prefix.length);
  if (subPath.length === 0) {
    return c.json({ error: 'Not found' }, 404);
  }

  const video = await c.env.DB.prepare(
    `SELECT user_id, playback_hls_path, hidden_at, dmca_status
     FROM videos
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(videoId)
    .first<{
      user_id: string;
      playback_hls_path: string | null;
      hidden_at: string | null;
      dmca_status: string | null;
    }>();

  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.dmca_status === 'disabled') {
    return c.json({ error: 'Unavailable for legal reasons', dmca: true }, 451);
  }

  const user = c.get('user');
  if (video.hidden_at && video.user_id !== user?.id) {
    return c.json({ error: 'Video not found' }, 404);
  }

  if (!video.playback_hls_path) {
    return c.json({ error: 'No HLS output for this video' }, 404);
  }

  const r2Key = resolveHlsKey(video.playback_hls_path, subPath);
  if (!r2Key) {
    return c.json({ error: 'Invalid HLS sub-path' }, 400);
  }

  if (c.req.method === 'HEAD') {
    const head = await c.env.VIDEOS.head(r2Key);
    if (!head) return c.json({ error: 'HLS asset not found' }, 404);
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': contentTypeForHlsAsset(subPath, head.httpMetadata?.contentType ?? null),
        'Content-Length': String(head.size),
        'Cache-Control': cacheControlForAsset(subPath),
      },
    });
  }

  const object = await c.env.VIDEOS.get(r2Key);
  if (!object) return c.json({ error: 'HLS asset not found' }, 404);
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForHlsAsset(subPath, object.httpMetadata?.contentType ?? null),
      'Content-Length': String(object.size),
      'Cache-Control': cacheControlForAsset(subPath),
    },
  });
});

// Manifests can be re-encoded; segments are content-addressed by encoder
// output and never rewritten in place. Cache accordingly.
function cacheControlForAsset(path: string): string {
  if (path.endsWith('.m3u8')) {
    return 'public, max-age=60, s-maxage=60';
  }
  return 'public, max-age=31536000, immutable';
}
