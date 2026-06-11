import { Hono } from 'hono';
import { z } from 'zod';
import { edgeCache, purgeEdgeCache } from './edge-cache';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

type SessionUser = { id: string };

export interface ThumbnailEnv {
  DB: D1Database;
  VIDEOS: R2Bucket;
}

export interface ThumbnailVariables {
  user: SessionUser | null;
}

// Cloudflare Stream customer subdomain. Per the docs, the per-account
// customer-<CODE>.cloudflarestream.com domain is the supported playback
// + thumbnail origin; videodelivery.net is legacy and may be retired.
//
// Source: https://developers.cloudflare.com/stream/viewing-videos/displaying-thumbnails/
//
// Hardcoded because the customer code is account-scoped (one per CF
// account) and rarely changes. If we ever need per-environment override,
// promote to an env var.
export const STREAM_CUSTOMER_HOST = 'customer-od6lvjm5bwfl1lki.cloudflarestream.com';

export function buildThumbnailCandidates(
  streamVideoId: string,
  durationSeconds: number | undefined,
): string[] {
  const base = `https://${STREAM_CUSTOMER_HOST}/${streamVideoId}/thumbnails/thumbnail.jpg`;
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [`${base}?time=1s`, `${base}?time=3s`, `${base}?time=5s`];
  }
  const timestamps = [0.1, 0.5, 0.9].map((pct) => {
    const seconds = Math.max(1, Math.round(durationSeconds * pct));
    return `${base}?time=${seconds}s`;
  });
  return timestamps;
}

const pickThumbnailSchema = z.object({
  url: z.string().url(),
});

function isOwnedR2ThumbnailUrl(url: string, userId: string, videoId: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith(`/api/thumbnails/${userId}/${videoId}/`);
  } catch {
    return false;
  }
}

export const thumbnailRoutes = new Hono<{
  Bindings: ThumbnailEnv;
  Variables: ThumbnailVariables;
}>();

thumbnailRoutes.put('/api/videos/:id/thumbnail', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const videoId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = pickThumbnailSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid thumbnail selection', details: parsed.error.flatten() }, 400);
  }

  const video = await c.env.DB.prepare(
    'SELECT id, user_id, thumbnail_candidates FROM videos WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(videoId)
    .first<{ id: string; user_id: string; thumbnail_candidates: string | null }>();
  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  let candidates: string[] = [];
  if (video.thumbnail_candidates) {
    try {
      const raw = JSON.parse(video.thumbnail_candidates) as unknown;
      if (Array.isArray(raw)) candidates = raw.filter((v): v is string => typeof v === 'string');
    } catch {
      candidates = [];
    }
  }

  const isCandidate = candidates.includes(parsed.data.url);
  const isOwned = isOwnedR2ThumbnailUrl(parsed.data.url, user.id, videoId);
  if (!isCandidate && !isOwned) {
    return c.json({ error: 'Thumbnail URL is not an allowed candidate or owned upload' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE videos SET thumbnail_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
    .bind(parsed.data.url, videoId)
    .run();

  // Thumbnail is part of video metadata — purge the KV-backed video meta cache
  // and the edge-cached video detail page (if it was cached without the thumbnail).
  const origin = new URL(c.req.url).origin;
  purgeEdgeCache(c, `${origin}/api/videos/${videoId}`);

  return c.json({ id: videoId, thumbnail_url: parsed.data.url });
});

thumbnailRoutes.post('/api/videos/:id/thumbnail', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const videoId = c.req.param('id');
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing thumbnail file' }, 400);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: `Unsupported thumbnail type: ${file.type || 'unknown'}` }, 400);
  }
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return c.json({ error: `Thumbnail exceeds ${MAX_THUMBNAIL_BYTES} bytes` }, 400);
  }

  const video = await c.env.DB.prepare(
    'SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(videoId)
    .first<{ id: string; user_id: string }>();
  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const ext = ALLOWED_EXT[file.type];
  const objectName = `${crypto.randomUUID()}.${ext}`;
  const r2Key = `thumbnails/${user.id}/${videoId}/${objectName}`;
  await c.env.VIDEOS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  const url = new URL(c.req.url);
  url.pathname = `/api/thumbnails/${user.id}/${videoId}/${objectName}`;
  url.search = '';
  const publicUrl = url.toString();

  await c.env.DB.prepare(
    'UPDATE videos SET thumbnail_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
    .bind(publicUrl, videoId)
    .run();

  const origin = new URL(c.req.url).origin;
  purgeEdgeCache(c, `${origin}/api/videos/${videoId}`);

  return c.json({ id: videoId, thumbnail_url: publicUrl }, 201);
});

thumbnailRoutes.get('/api/thumbnails/:userId/:videoId/:objectName', edgeCache({ ttl: 31536000 }), async (c) => {
  const { userId, videoId, objectName } = c.req.param();
  if (!/^[a-zA-Z0-9._-]+$/.test(objectName)) {
    return c.json({ error: 'Invalid object name' }, 400);
  }
  const r2Key = `thumbnails/${userId}/${videoId}/${objectName}`;
  const object = await c.env.VIDEOS.get(r2Key);
  if (!object) return c.json({ error: 'Thumbnail not found' }, 404);
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});
