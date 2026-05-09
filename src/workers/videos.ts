import { Hono } from 'hono';
import { z } from 'zod';
import { ensureSessionId, shouldCountView } from './analytics';
import { triggerFanOut } from './channel-do';
import {
  completedPartsForR2,
  deleteManifest,
  loadManifest,
  manifestProgress,
  partNumberForChunkIndex,
  saveManifest,
  totalBytesInManifest,
  type UploadManifest,
} from './chunked-upload';
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
} from './upload-validation';
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

export interface VideoRoutesEnv {
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

export const videoRoutes = new Hono<{
  Bindings: VideoRoutesEnv;
  Variables: VideoRoutesVariables;
}>();

videoRoutes.get('/api/videos/trending', async (c) => {
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

videoRoutes.get('/api/videos', async (c) => {
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

videoRoutes.get('/api/videos/:id', async (c) => {
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
    await bumpTrendingCacheVersion(env.CACHE);

    return c.json({ id: videoId, status: 'queued' }, 201);
  }

  // Resumable multipart path. Either the client is starting a fresh upload
  // (no uploadId, chunkIndex===0) or resuming an existing one (uploadId
  // provided; any chunkIndex in [0, chunkCount-1]).
  let resolvedUploadId = uploadId ?? '';
  let manifest: UploadManifest | null = uploadId
    ? await loadManifest(env, user.id, uploadId)
    : null;

  if (!manifest) {
    // No manifest in KV — must be a fresh init. Anything else is a stale or
    // forged uploadId; tell the client to restart from chunk 0.
    if (chunkIndex !== 0) {
      return c.json({ error: 'Missing upload session. Start with chunkIndex=0.' }, 400);
    }
    resolvedUploadId = uploadId ?? crypto.randomUUID();
    const videoId = crypto.randomUUID();
    const r2Key = `${user.id}/${videoId}/${rawFile.name}`;
    const created = await env.VIDEOS.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: rawFile.type },
    });
    manifest = {
      videoId,
      r2Key,
      multipartUploadId: created.uploadId,
      title: metadataParsed.data.title,
      description: metadataParsed.data.description,
      fileName: rawFile.name,
      contentType: rawFile.type,
      chunkCount,
      parts: {},
      createdAt: Date.now(),
    };
  } else {
    // Existing manifest: enforce that chunkCount stays consistent — a client
    // resuming the same upload must use the same total chunk count.
    if (manifest.chunkCount !== chunkCount) {
      return c.json(
        {
          error: 'chunkCount mismatch with existing upload session',
          code: 'chunk_count_mismatch',
        },
        400,
      );
    }
    resolvedUploadId = uploadId as string;
  }

  const partNumber = partNumberForChunkIndex(chunkIndex);
  const existingPart = manifest.parts[String(partNumber)];

  // Precompute the prospective post-upload byte total so we can reject
  // before paying the R2 write. If this chunk replaces an existing part
  // (idempotent retry), subtract the old size from the prior total.
  const priorBytes = totalBytesInManifest(manifest) - (existingPart?.size ?? 0);
  if (priorBytes + rawFile.size > MAX_VIDEO_BYTES) {
    return c.json(
      { error: `Upload exceeds ${MAX_VIDEO_BYTES} bytes`, code: 'file_too_large' },
      400,
    );
  }

  const multipart = env.VIDEOS.resumeMultipartUpload(
    manifest.r2Key,
    manifest.multipartUploadId,
  );
  const uploadedPart = await multipart.uploadPart(partNumber, rawFile.stream());

  manifest.parts[String(partNumber)] = { etag: uploadedPart.etag, size: rawFile.size };

  // Persist the updated manifest *before* completion so a crash between
  // uploadPart and complete leaves a recoverable manifest with one extra
  // part, not a lost one.
  await saveManifest(env, user.id, resolvedUploadId, manifest);

  if (Object.keys(manifest.parts).length < chunkCount) {
    return c.json(
      { status: 'chunk_received', chunkIndex, chunkCount, uploadId: resolvedUploadId },
      202,
    );
  }

  // All chunks present — commit.
  const completedParts = completedPartsForR2(manifest);
  if (completedParts.length !== chunkCount) {
    return c.json({ error: 'Missing one or more chunks before completion' }, 400);
  }

  // ALO-139: authoritative quota check at completion. Catches the case
  // where the first-chunk precheck passed but a parallel upload (or a
  // very large total via many small chunks) would push the user over.
  const totalBytes = totalBytesInManifest(manifest);
  const finalUsage = await getStorageUsage(env, user.id);
  if (!hasRoomFor(finalUsage, totalBytes)) {
    await multipart.abort().catch(() => {});
    await deleteManifest(env, user.id, resolvedUploadId);
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
      manifest.videoId,
      user.id,
      manifest.title,
      manifest.description,
      manifest.r2Key,
      totalBytes,
      'queued',
    )
    .run();

  await env.VIDEO_ENCODING.send({ videoId: manifest.videoId, r2Key: manifest.r2Key });
  await triggerFanOut(env.CHANNEL_SUBSCRIBER_DO, {
    videoId: manifest.videoId,
    channelUserId: user.id,
  });
  await bumpTrendingCacheVersion(env.CACHE);

  await deleteManifest(env, user.id, resolvedUploadId);

  return c.json({ id: manifest.videoId, status: 'queued' }, 201);
});

// ALO-134: status query. Lets a client that disconnected mid-upload
// fetch the manifest and resume from `nextChunkIndex`. Clients can
// alternately walk `receivedChunks` to fill any gaps.
videoRoutes.get('/api/videos/upload/:uploadId/status', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const uploadId = c.req.param('uploadId');
  const manifest = await loadManifest(c.env, user.id, uploadId);
  if (!manifest) {
    return c.json({ error: 'Upload session not found', code: 'upload_not_found' }, 404);
  }
  return c.json(manifestProgress(uploadId, manifest));
});

// ALO-134: explicit abort. Releases the in-flight R2 multipart upload (so
// the user isn't billed for orphan parts) and clears the manifest. Idempotent
// — calling DELETE on an already-cleared upload returns 404 with the same
// code so the client can treat it as success.
videoRoutes.delete('/api/videos/upload/:uploadId', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const uploadId = c.req.param('uploadId');
  const manifest = await loadManifest(c.env, user.id, uploadId);
  if (!manifest) {
    return c.json({ error: 'Upload session not found', code: 'upload_not_found' }, 404);
  }
  const multipart = c.env.VIDEOS.resumeMultipartUpload(
    manifest.r2Key,
    manifest.multipartUploadId,
  );
  // R2 abort can fail if the upload was already aborted or completed;
  // either way the manifest should still go.
  await multipart.abort().catch(() => {});
  await deleteManifest(c.env, user.id, uploadId);
  return c.json({ success: true, uploadId });
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

  return c.json({ success: true });
});
