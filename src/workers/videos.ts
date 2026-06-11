import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { ensureSessionId, shouldCountView } from './analytics';
import { triggerFanOut } from './channel-do';
import { sendNewUploadEmails } from './notification-email';
import { waitUntilBackground } from './wait-until';
import {
  UPLOAD_INIT_BUCKET,
  rateLimit,
  rateLimitHeaders,
} from './rate-limit';
import {
  MAX_VIDEO_BYTES,
  parseChunkMetadataFromFormData,
  validateChunkShape,
  validateInitialFile,
  validateMagicBytes,
} from './upload-validation';
import { verifyTurnstile, type TurnstileEnv } from './turnstile';
import { edgeCache, purgeEdgeCache, purgeTrendingEdgeCache } from './edge-cache';
import { VIDEO_META_CACHE_TTL_SECONDS, videoMetaCacheKey } from './video-meta-cache';
import { parseRangeHeader } from './video-range';
import { getStorageUsage, hasRoomFor } from './storage-quota';
import {
  TRENDING_CACHE_TTL_SECONDS,
  bumpTrendingCacheVersion,
  getTrendingCacheVersion,
  trendingCacheKey,
} from './trending-cache';

interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface VideoRoutesEnv extends TurnstileEnv {
  VIDEOS: R2Bucket;
  DB: D1Database;
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;
  CHANNEL_SUBSCRIBER_DO?: DurableObjectNamespace;
  RATE_LIMITER?: DurableObjectNamespace;
  VIDEO_ENCODING: Queue;
  ANALYTICS?: AnalyticsEngineDataset;
}

type SessionUser = { id: string; email: string; name: string; emailVerified?: boolean } | null;
type VideoRoutesVariables = { user: SessionUser };

type CachedVideoMeta = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  r2_key: string;
  stream_video_id: string | null;
  status: string;
  view_count: number;
  created_at: string;
  updated_at: string;
  channel_name: string | null;
  channel_username: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
};

const listVideosQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const trendingQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(12),
});

const uploadMetadataSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).optional().default(''),
});

const uploadMetaPersistedSchema = z.object({
  videoId: z.string(),
  r2Key: z.string(),
  title: z.string(),
  description: z.string(),
  chunkCount: z.number().int().positive(),
});

export const videoRoutes = new Hono<{
  Bindings: VideoRoutesEnv;
  Variables: VideoRoutesVariables;
}>();

videoRoutes.get('/api/videos/trending', edgeCache({ ttl: 300, swr: 600 }), async (c) => {
  const parsed = trendingQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }

  const { limit } = parsed.data;
  const version = await getTrendingCacheVersion(c.env.CACHE);
  const cacheKey = trendingCacheKey(version, limit);

  const cached = await c.env.CACHE.get(cacheKey, 'json');
  if (cached) {
    return c.json({ limit, videos: cached, cached: true });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.user_id, v.title, v.description, v.stream_video_id, v.thumbnail_url,
            v.view_count, v.created_at, u.name AS channel_name,
            COUNT(views.id) AS recent_views
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     LEFT JOIN views ON views.video_id = v.id
       AND views.viewed_at >= datetime('now', '-7 days')
     WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL
     GROUP BY v.id
     ORDER BY recent_views DESC, v.view_count DESC, v.created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();

  await c.env.CACHE.put(cacheKey, JSON.stringify(results), {
    expirationTtl: TRENDING_CACHE_TTL_SECONDS,
  });

  return c.json({ limit, videos: results, cached: false });
});

videoRoutes.get('/api/videos', edgeCache({ ttl: 30, swr: 60 }), async (c) => {
  const parsed = listVideosQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }

  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const { results } = await c.env.DB.prepare(
    `SELECT id, user_id, title, description, r2_key, stream_video_id, status, view_count, created_at, updated_at
     FROM videos
     WHERE deleted_at IS NULL AND hidden_at IS NULL
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();

  return c.json({ page, limit, videos: results });
});

videoRoutes.get('/api/videos/:id', edgeCache({ ttl: 60, swr: 300 }), async (c) => {
  const id = c.req.param('id');

  const cacheKey = videoMetaCacheKey(id);
  let video = await c.env.CACHE.get<CachedVideoMeta>(cacheKey, 'json');
  const cacheHit = video !== null;

  if (!video) {
    video = await c.env.DB.prepare(
      `SELECT v.id, v.user_id, v.title, v.description, v.r2_key, v.stream_video_id, v.status,
              v.view_count, v.created_at, v.updated_at, v.hidden_at, v.dmca_status,
              u.name AS channel_name, u.username AS channel_username
       FROM videos v
       LEFT JOIN user u ON u.id = v.user_id
       WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
      .bind(id)
      .first<CachedVideoMeta>();

    if (!video) {
      return c.json({ error: 'Video not found' }, 404);
    }

    if (video.status === 'ready' && !video.hidden_at && !video.dmca_status) {
      // Only cache stable, viewable rows. Encoding/failed/hidden/DMCA states
      // change and aren't worth a stale cache.
      await c.env.CACHE.put(cacheKey, JSON.stringify(video), {
        expirationTtl: VIDEO_META_CACHE_TTL_SECONDS,
      });
    }
  }

  const user = c.get('user');
  if (video.dmca_status === 'disabled') {
    // 451 Unavailable For Legal Reasons. The SPA renders /dmca-notice/:id when
    // it sees this response.
    return c.json({ error: 'Unavailable for legal reasons', dmca: true }, 451);
  }
  if (video.hidden_at && video.user_id !== user?.id) {
    return c.json({ error: 'Video not found' }, 404);
  }
  const { sid, setCookie } = ensureSessionId(c.req.header('cookie') ?? null);
  // Dedup by user id when authenticated, else by anon session id, so opening
  // the same tab twice in 12h doesn't double-count.
  const identity = user ? `u:${user.id}` : `s:${sid}`;
  const fresh = await shouldCountView(c.env.CACHE, id, identity);

  let viewCount = Number(video.view_count ?? 0);
  if (fresh) {
    await c.env.DB.prepare('UPDATE videos SET view_count = view_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(id)
      .run();
    await c.env.DB.prepare('INSERT INTO views (video_id, user_id, viewed_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .bind(id, user?.id ?? null)
      .run();
    viewCount += 1;

    c.env.ANALYTICS?.writeDataPoint({
      indexes: [id],
      blobs: ['view', user?.id ?? '', sid],
      doubles: [1],
    });
  }

  if (setCookie) c.header('Set-Cookie', setCookie, { append: true });

  c.header('x-spooool-cache', cacheHit ? 'hit' : 'miss');
  return c.json({
    ...video,
    view_count: viewCount,
  });
});

// Direct R2 playback for videos that haven't been transcoded by Cloudflare
// Stream (e.g. Stream isn't enabled, or the video is still encoding). Browsers
// require Range support for seekable <video> playback. When stream_video_id is
// present and status='ready', clients should use the HLS manifest instead.
videoRoutes.on(['GET', 'HEAD'], '/api/videos/:id/stream', async (c) => {
  const id = c.req.param('id');
  const video = await c.env.DB.prepare(
    `SELECT user_id, r2_key, hidden_at, dmca_status
     FROM videos
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{
      user_id: string;
      r2_key: string;
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

  const head = await c.env.VIDEOS.head(video.r2_key);
  if (!head) return c.json({ error: 'Video object missing' }, 404);

  const totalSize = head.size;
  const contentType = head.httpMetadata?.contentType ?? 'video/mp4';
  const range = parseRangeHeader(c.req.header('Range'), totalSize);

  if (range.kind === 'invalid') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` },
    });
  }

  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  if (range.kind === 'absent') {
    const object = await c.env.VIDEOS.get(video.r2_key);
    if (!object) return c.json({ error: 'Video object missing' }, 404);
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const object = await c.env.VIDEOS.get(video.r2_key, {
    range: { offset: range.offset, length: range.length },
  });
  if (!object) return c.json({ error: 'Video object missing' }, 404);

  return new Response(object.body, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(range.length),
      'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

// HLS proxy for the R2+FFmpeg fallback path (ALO-136). The encoder stores
// playlists and segments under hls/{videoId}/ in R2. Relative URLs inside
// the playlists resolve correctly through this proxy because the browser
// resolves them against the response URL (e.g. master.m3u8 → 1080p.m3u8
// → /api/videos/:id/hls/1080p.m3u8, then 1080p_seg000.ts resolves too).
videoRoutes.get('/api/videos/:id/hls/*', async (c) => {
  const id = c.req.param('id');
  const rest = c.req.path.slice(`/api/videos/${id}/hls/`.length);

  // HLS players fire one request per segment; hitting D1 on every one would
  // exhaust the database under load. The auth row is tiny and changes rarely,
  // so cache it in KV for 60s (matches the playlist's max-age=60 freshness).
  type HlsAuthRow = {
    status: string;
    stream_video_id: string | null;
    hidden_at: string | null;
    dmca_status: string | null;
    user_id: string;
  };
  const authKey = `hls-auth:${id}`;
  let video = await c.env.CACHE.get<HlsAuthRow>(authKey, 'json');
  if (!video) {
    video = await c.env.DB.prepare(
      `SELECT status, stream_video_id, hidden_at, dmca_status, user_id
       FROM videos WHERE id = ? AND deleted_at IS NULL`,
    ).bind(id).first<HlsAuthRow>();
    if (video) {
      await c.env.CACHE.put(authKey, JSON.stringify(video), { expirationTtl: 60 });
    }
  }

  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.dmca_status === 'disabled') return c.json({ error: 'Unavailable for legal reasons', dmca: true }, 451);
  const user = c.get('user');
  if (video.hidden_at && video.user_id !== user?.id) return c.json({ error: 'Video not found' }, 404);
  if (video.status !== 'ready' || video.stream_video_id) return c.json({ error: 'HLS not available' }, 404);

  const r2Key = `hls/${id}/${rest}`;
  const object = await c.env.VIDEOS.get(r2Key);
  if (!object) return c.json({ error: 'Segment not found' }, 404);

  const isPlaylist = rest.endsWith('.m3u8');
  const contentType = isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': isPlaylist ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    },
  });
});

type VideoRoutesContext = Context<{
  Bindings: VideoRoutesEnv;
  Variables: VideoRoutesVariables;
}>;

async function handleRecorderUpload(
  c: VideoRoutesContext,
  formData: FormData,
): Promise<Response> {
  const env = c.env;
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (user.emailVerified === false) {
    return c.json({ error: 'Verify your email before recording.', code: 'email_unverified' }, 403);
  }

  const sessionId = formData.get('sessionId') as string | null;
  const takeId = formData.get('takeId') as string | null;
  const rawFile = formData.get('file');

  if (!sessionId || !takeId) {
    return c.json({ error: 'sessionId and takeId required for recorder uploads' }, 400);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(takeId)) {
    return c.json({ error: 'invalid sessionId or takeId' }, 400);
  }

  const earlyUploadId = formData.get('uploadId') as string | null;
  if (earlyUploadId && !/^[A-Za-z0-9_-]{1,64}$/.test(earlyUploadId)) {
    return c.json({ error: 'invalid uploadId' }, 400);
  }
  if (!(rawFile instanceof File)) {
    return c.json({ error: 'File is required' }, 400);
  }

  const chunkParsed = parseChunkMetadataFromFormData(formData);
  if (!chunkParsed.success) {
    return c.json({ error: 'Invalid chunk metadata', details: chunkParsed.error.flatten() }, 400);
  }
  const { uploadId, chunkIndex, chunkCount } = chunkParsed.data;

  const chunkError = validateChunkShape({ chunkSize: rawFile.size, chunkIndex, chunkCount });
  if (chunkError) return c.json({ error: chunkError.message, code: chunkError.code }, 400);

  if (chunkIndex === 0) {
    const headerBytes = new Uint8Array(await rawFile.slice(0, 12).arrayBuffer());
    const magicError = validateMagicBytes(headerBytes);
    if (magicError) {
      return c.json({ error: magicError.message, code: magicError.code }, 400);
    }
  }

  const r2Key = `recorder/raw/${user.id}/${sessionId}/${takeId}.webm`;

  // Single-chunk upload: write directly to R2.
  if (chunkCount === 1) {
    await env.VIDEOS.put(r2Key, rawFile.stream(), {
      httpMetadata: { contentType: 'video/webm' },
    });
    return c.json({ ok: true, r2Key });
  }

  // Multi-chunk: KV-backed R2 multipart keyed under :rec: to avoid collisions
  // with the video-upload namespace.
  const resolvedUploadId = uploadId ?? crypto.randomUUID();
  const baseKvKey = `upload:rec:${user.id}:${resolvedUploadId}`;
  const mpidKey = `${baseKvKey}:mpid`;
  const metaKey = `${baseKvKey}:meta`;
  const partsKey = `${baseKvKey}:parts`;

  if (chunkIndex === 0) {
    const multipart = await env.VIDEOS.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: 'video/webm' },
    });
    const firstPart = await multipart.uploadPart(1, rawFile.stream());
    await env.SESSIONS.put(mpidKey, multipart.uploadId, { expirationTtl: 86400 });
    await env.SESSIONS.put(
      metaKey,
      JSON.stringify({ r2Key, chunkCount }),
      { expirationTtl: 86400 },
    );
    await env.SESSIONS.put(
      partsKey,
      JSON.stringify({ '1': { etag: firstPart.etag, size: rawFile.size } } as Record<string, { etag: string; size: number }>),
      { expirationTtl: 86400 },
    );
    return c.json({ status: 'chunk_received', chunkIndex, chunkCount, uploadId: resolvedUploadId }, 202);
  }

  const [multipartUploadId, uploadMetaJson, partsJson] = await Promise.all([
    env.SESSIONS.get(mpidKey),
    env.SESSIONS.get(metaKey),
    env.SESSIONS.get(partsKey),
  ]);

  if (!multipartUploadId || !uploadMetaJson) {
    // KV session expired (24h TTL) but multipart may still exist in R2.
    // Best-effort abort so we don't leak parts. The key was deterministic so
    // even without metaKey we know the R2 key from the request inputs.
    if (multipartUploadId) {
      const recoveryKey = `recorder/raw/${user.id}/${sessionId}/${takeId}.webm`;
      await c.env.VIDEOS.resumeMultipartUpload(recoveryKey, multipartUploadId).abort().catch(() => {});
    }
    return c.json({ error: 'Missing upload session. Start with chunkIndex=0.' }, 400);
  }

  const uploadMeta = JSON.parse(uploadMetaJson) as { r2Key: string; chunkCount: number };
  const uploadedPartsMap: Record<string, { etag: string; size: number }> = partsJson
    ? (JSON.parse(partsJson) as Record<string, { etag: string; size: number }>)
    : {};

  const multipart = env.VIDEOS.resumeMultipartUpload(uploadMeta.r2Key, multipartUploadId);
  const uploadedPart = await multipart.uploadPart(chunkIndex + 1, rawFile.stream());
  uploadedPartsMap[String(chunkIndex + 1)] = { etag: uploadedPart.etag, size: rawFile.size };
  await env.SESSIONS.put(partsKey, JSON.stringify(uploadedPartsMap), { expirationTtl: 86400 });

  if (chunkIndex < chunkCount - 1) {
    return c.json({ status: 'chunk_received', chunkIndex, chunkCount }, 202);
  }

  const completedParts = Object.entries(uploadedPartsMap)
    .map(([partNumber, part]) => ({ partNumber: Number(partNumber), etag: part.etag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  if (completedParts.length !== chunkCount) {
    return c.json({ error: 'Missing one or more chunks before completion' }, 400);
  }

  await multipart.complete(completedParts);
  await Promise.all([
    env.SESSIONS.delete(mpidKey),
    env.SESSIONS.delete(metaKey),
    env.SESSIONS.delete(partsKey),
  ]);

  return c.json({ ok: true, r2Key: uploadMeta.r2Key, uploadId: resolvedUploadId });
}

videoRoutes.post('/api/videos/upload', async (c) => {
  const env = c.env;
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // ALO-128: gate uploads on a verified email so freshly-signed-up accounts
  // can't immediately push content. The frontend keys off the `code` field
  // to render the "verify your email" banner.
  if (user.emailVerified === false) {
    return c.json(
      { error: 'Verify your email before uploading.', code: 'email_unverified' },
      403,
    );
  }

  const formData = await c.req.formData();
  const target = (formData.get('target') as string | null) ?? 'video';
  if (target === 'recorder') {
    return handleRecorderUpload(c, formData);
  }
  const rawTitle = formData.get('title');
  const rawDescription = formData.get('description');
  const rawFile = formData.get('file');

  const metadataParsed = uploadMetadataSchema.safeParse({
    title: rawTitle,
    description: rawDescription ?? '',
  });

  if (!metadataParsed.success) {
    return c.json({ error: 'Invalid upload metadata', details: metadataParsed.error.flatten() }, 400);
  }

  if (!(rawFile instanceof File)) {
    return c.json({ error: 'File is required' }, 400);
  }

  const chunkParsed = parseChunkMetadataFromFormData(formData);

  if (!chunkParsed.success) {
    return c.json({ error: 'Invalid chunk metadata', details: chunkParsed.error.flatten() }, 400);
  }

  const { uploadId, chunkIndex, chunkCount } = chunkParsed.data;

  const chunkError = validateChunkShape({
    chunkSize: rawFile.size,
    chunkIndex,
    chunkCount,
  });
  if (chunkError) {
    return c.json({ error: chunkError.message, code: chunkError.code }, 400);
  }

  if (chunkIndex === 0) {
    // ALO-168: per-user rate limit on the init step only. Subsequent chunks of
    // the same upload pass freely so a long upload doesn't fail mid-stream
    // because of bucket exhaustion.
    const rl = await rateLimit({
      ns: env.RATE_LIMITER,
      bucket: UPLOAD_INIT_BUCKET,
      identity: `u:${user.id}`,
    });
    if (!rl.allowed) {
      return c.json(
        { error: 'Upload rate limit exceeded. Try again shortly.' },
        429,
        rateLimitHeaders(rl),
      );
    }

    const captchaToken = c.req.header('x-captcha-response');
    const captcha = await verifyTurnstile(captchaToken, env.TURNSTILE_SECRET_KEY);
    if (!captcha.success) {
      return c.json({ error: captcha.error ?? 'Captcha verification failed' }, 403);
    }

    const initialError = validateInitialFile({
      fileName: rawFile.name,
      mimeType: rawFile.type,
      totalSize: chunkCount === 1 ? rawFile.size : undefined,
    });
    if (initialError) {
      return c.json({ error: initialError.message, code: initialError.code }, 400);
    }

    // ALO-139: precheck the user's storage quota before we pay for the
    // first R2 write or open a multipart upload. We only know the chunk-0
    // size at this point — for multipart, completion does the final
    // authoritative check against the actual total.
    const usage = await getStorageUsage(env, user.id);
    if (!hasRoomFor(usage, rawFile.size)) {
      return c.json(
        {
          error: 'Storage quota exceeded.',
          code: 'storage_quota_exceeded',
          storage: usage,
        },
        413,
      );
    }

    const headerBytes = new Uint8Array(await rawFile.slice(0, 12).arrayBuffer());
    const magicError = validateMagicBytes(headerBytes);
    if (magicError) {
      return c.json({ error: magicError.message, code: magicError.code }, 400);
    }
  }

  if (chunkCount === 1) {
    const videoId = crypto.randomUUID();
    const r2Key = `${user.id}/${videoId}/${rawFile.name}`;

    await env.VIDEOS.put(r2Key, rawFile.stream(), {
      httpMetadata: { contentType: rawFile.type },
    });

    await env.DB.prepare(
      `INSERT INTO videos (id, user_id, title, description, r2_key, bytes, status, view_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
      .bind(
        videoId,
        user.id,
        metadataParsed.data.title,
        metadataParsed.data.description,
        r2Key,
        rawFile.size,
        'queued',
      )
      .run();

    await env.VIDEO_ENCODING.send({ videoId, r2Key });
    await triggerFanOut(env.CHANNEL_SUBSCRIBER_DO, {
      videoId,
      channelUserId: user.id,
    });
    waitUntilBackground(c, sendNewUploadEmails(c.env as Parameters<typeof sendNewUploadEmails>[0], {
      videoId,
      channelUserId: user.id,
      channelName: user.name,
      videoTitle: metadataParsed.data.title,
      origin: new URL(c.req.url).origin,
    }).catch((err) => {
      console.warn('new-upload email failed', { videoId, error: err instanceof Error ? err.message : String(err) });
    }));
    await bumpTrendingCacheVersion(env.CACHE);
    purgeTrendingEdgeCache(c);

    return c.json({ id: videoId, status: 'queued' }, 201);
  }

  const resolvedUploadId = uploadId ?? crypto.randomUUID();

  const baseKvKey = `upload:${user.id}:${resolvedUploadId}`;
  const mpidKey = `${baseKvKey}:mpid`;
  const metaKey = `${baseKvKey}:meta`;
  const partsKey = `${baseKvKey}:parts`;

  if (chunkIndex === 0) {
    const videoId = crypto.randomUUID();
    const r2Key = `${user.id}/${videoId}/${rawFile.name}`;
    const multipart = await env.VIDEOS.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: rawFile.type },
    });

    const firstPart = await multipart.uploadPart(1, rawFile.stream());

    await env.SESSIONS.put(mpidKey, multipart.uploadId, { expirationTtl: 86400 });
    await env.SESSIONS.put(
      metaKey,
      JSON.stringify({
        videoId,
        r2Key,
        title: metadataParsed.data.title,
        description: metadataParsed.data.description,
        chunkCount,
      }),
      { expirationTtl: 86400 },
    );
    await env.SESSIONS.put(
      partsKey,
      JSON.stringify({ '1': { etag: firstPart.etag, size: rawFile.size } } as Record<
        string,
        { etag: string; size: number }
      >),
      { expirationTtl: 86400 },
    );
    return c.json({ status: 'chunk_received', chunkIndex, chunkCount, uploadId: resolvedUploadId }, 202);
  }

  const [multipartUploadId, uploadMetaJson, partsJson] = await Promise.all([
    env.SESSIONS.get(mpidKey),
    env.SESSIONS.get(metaKey),
    env.SESSIONS.get(partsKey),
  ]);

  if (!multipartUploadId || !uploadMetaJson) {
    return c.json({ error: 'Missing upload session. Start with chunkIndex=0.' }, 400);
  }

  const uploadMeta = uploadMetaPersistedSchema.parse(JSON.parse(uploadMetaJson));

  const uploadedPartsMap = partsJson
    ? (JSON.parse(partsJson) as Record<string, { etag: string; size: number }>)
    : {};

  const priorBytes = Object.values(uploadedPartsMap).reduce((sum, part) => sum + part.size, 0);
  if (priorBytes + rawFile.size > MAX_VIDEO_BYTES) {
    return c.json(
      { error: `Upload exceeds ${MAX_VIDEO_BYTES} bytes`, code: 'file_too_large' },
      400,
    );
  }

  const multipart = env.VIDEOS.resumeMultipartUpload(uploadMeta.r2Key, multipartUploadId);
  const uploadedPart = await multipart.uploadPart(chunkIndex + 1, rawFile.stream());

  uploadedPartsMap[String(chunkIndex + 1)] = { etag: uploadedPart.etag, size: rawFile.size };
  await env.SESSIONS.put(partsKey, JSON.stringify(uploadedPartsMap), { expirationTtl: 86400 });

  if (chunkIndex < chunkCount - 1) {
    return c.json({ status: 'chunk_received', chunkIndex, chunkCount }, 202);
  }

  const completedParts = Object.entries(uploadedPartsMap)
    .map(([partNumber, part]) => ({ partNumber: Number(partNumber), etag: part.etag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  if (completedParts.length !== chunkCount) {
    return c.json({ error: 'Missing one or more chunks before completion' }, 400);
  }

  // ALO-139: authoritative quota check at completion. Catches the case
  // where the first-chunk precheck passed but a parallel upload (or a
  // very large total via many small chunks) would push the user over.
  const totalBytes = priorBytes + rawFile.size;
  const finalUsage = await getStorageUsage(env, user.id);
  if (!hasRoomFor(finalUsage, totalBytes)) {
    await multipart.abort().catch(() => {});
    await Promise.all([
      env.SESSIONS.delete(mpidKey),
      env.SESSIONS.delete(metaKey),
      env.SESSIONS.delete(partsKey),
    ]);
    return c.json(
      {
        error: 'Storage quota exceeded.',
        code: 'storage_quota_exceeded',
        storage: finalUsage,
      },
      413,
    );
  }

  await multipart.complete(completedParts);

  await env.DB.prepare(
    `INSERT INTO videos (id, user_id, title, description, r2_key, bytes, status, view_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(
      uploadMeta.videoId,
      user.id,
      uploadMeta.title,
      uploadMeta.description,
      uploadMeta.r2Key,
      totalBytes,
      'queued',
    )
    .run();

  await env.VIDEO_ENCODING.send({ videoId: uploadMeta.videoId, r2Key: uploadMeta.r2Key });
  await triggerFanOut(env.CHANNEL_SUBSCRIBER_DO, {
    videoId: uploadMeta.videoId,
    channelUserId: user.id,
  });
  waitUntilBackground(c, sendNewUploadEmails(c.env as Parameters<typeof sendNewUploadEmails>[0], {
    videoId: uploadMeta.videoId,
    channelUserId: user.id,
    channelName: user.name,
    videoTitle: uploadMeta.title,
    origin: new URL(c.req.url).origin,
  }).catch((err) => {
    console.warn('new-upload email failed', { videoId: uploadMeta.videoId, error: err instanceof Error ? err.message : String(err) });
  }));
  await bumpTrendingCacheVersion(env.CACHE);
  purgeTrendingEdgeCache(c);

  await Promise.all([env.SESSIONS.delete(mpidKey), env.SESSIONS.delete(metaKey), env.SESSIONS.delete(partsKey)]);

  return c.json({ id: uploadMeta.videoId, status: 'queued' }, 201);
});

videoRoutes.delete('/api/videos/:id', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const id = c.req.param('id');
  const video = await c.env.DB.prepare('SELECT id, user_id, r2_key FROM videos WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: string; user_id: string; r2_key: string }>();

  if (!video) {
    return c.json({ error: 'Video not found' }, 404);
  }

  if (video.user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare('UPDATE videos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(id)
    .run();

  await c.env.VIDEOS.delete(video.r2_key);
  await c.env.CACHE.delete(videoMetaCacheKey(id));
  await bumpTrendingCacheVersion(c.env.CACHE);

  // Purge the video metadata entry and trending list from the edge cache so
  // the deletion is reflected immediately rather than waiting for TTL expiry.
  const origin = new URL(c.req.url).origin;
  purgeEdgeCache(
    c,
    `${origin}/api/videos/${id}`,
    `${origin}/api/videos/trending`,
    `${origin}/api/videos/trending?limit=12`,
  );

  return c.json({ success: true });
});
