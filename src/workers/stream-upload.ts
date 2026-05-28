// Direct creator upload endpoint for Cloudflare Stream.
//
// The client never sees CF_STREAM_API_TOKEN. Instead it POSTs to this
// endpoint, the worker uses the `[stream] binding = "STREAM"` to mint a
// one-time upload URL, and the client uploads the video file directly
// to Stream via basic POST (files < 200MB) or tus (> 200MB; out of scope
// for v1).
//
// Best-practice settings applied per upload:
//   - maxDurationSeconds: hard limit driven by the client + capped to
//     keep storage reservations bounded.
//   - creator: user.id so Stream Analytics maps each upload back to a
//     spooool account.
//   - meta: { sessionId, userId, source } for our own dashboards.
//   - allowedOrigins: spooool.com + workers.dev preview hosts so the
//     uploaded video can't be hot-linked from arbitrary sites.
//
// Docs:
//   https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/
//   https://developers.cloudflare.com/api/resources/stream/subresources/direct_upload/methods/create/

import { Hono } from 'hono';
import { z } from 'zod';
import { UPLOAD_INIT_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';

const MAX_DURATION_SECONDS = 60 * 30; // 30 min upper bound
const ALLOWED_ORIGINS = ['spooool.com', 'www.spooool.com', '*.workers.dev'];

interface StreamDirectUploadResult {
  uid: string;
  uploadURL: string;
  scheduledDeletion?: string;
  watermark?: { uid: string };
}

interface StreamBinding {
  /**
   * Workers Binding API for Stream. Returns a one-time upload URL +
   * uid. The Cloudflare runtime types call this `createDirectUpload`.
   */
  createDirectUpload: (input: {
    maxDurationSeconds: number;
    creator?: string;
    meta?: Record<string, string>;
    allowedOrigins?: string[];
    requireSignedURLs?: boolean;
    scheduledDeletion?: string;
    thumbnailTimestampPct?: number;
  }) => Promise<StreamDirectUploadResult>;
}

export interface StreamUploadEnv {
  STREAM: StreamBinding;
  RATE_LIMITER?: DurableObjectNamespace;
}

interface SessionUser {
  id: string;
  emailVerified: boolean;
}
type StreamUploadVariables = { user: SessionUser | null };

const bodySchema = z.object({
  maxDurationSeconds: z.number().int().positive().max(MAX_DURATION_SECONDS).optional(),
  requireSignedURLs: z.boolean().optional(),
  meta: z.record(z.string(), z.string()).optional(),
});

export const streamUploadRoutes = new Hono<{
  Bindings: StreamUploadEnv;
  Variables: StreamUploadVariables;
}>();

streamUploadRoutes.post('/api/stream/upload-url', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  // Reuse the upload-init bucket: 20 mints per hour per user. Mirrors the
  // R2 multipart-upload bucket so abuse limits are consistent across the
  // two upload paths.
  const rl = await rateLimit({
    ns: c.env.RATE_LIMITER,
    bucket: UPLOAD_INIT_BUCKET,
    identity: user.id,
  });
  if (!rl.allowed) {
    return c.json(
      { error: 'Too many upload requests. Try again shortly.' },
      429,
      rateLimitHeaders(rl),
    );
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const userMeta = parsed.data.meta ?? {};
  // Always stamp our own metadata so it survives even if the client
  // omits or overwrites these keys.
  const meta: Record<string, string> = {
    ...userMeta,
    spooool_user_id: user.id,
    spooool_source: 'direct_upload',
  };

  try {
    const result = await c.env.STREAM.createDirectUpload({
      maxDurationSeconds: parsed.data.maxDurationSeconds ?? MAX_DURATION_SECONDS,
      creator: user.id,
      meta,
      allowedOrigins: ALLOWED_ORIGINS,
      requireSignedURLs: parsed.data.requireSignedURLs ?? false,
    });
    return c.json({
      uid: result.uid,
      uploadURL: result.uploadURL,
      // Mirror the customer subdomain to the client so the player can
      // construct manifest / thumbnail / iframe URLs without hardcoding
      // the host on the frontend.
      customerHost: 'customer-od6lvjm5bwfl1lki.cloudflarestream.com',
    });
  } catch (err) {
    console.error('[stream-upload] createDirectUpload threw', {
      userId: user.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'Could not create upload URL' }, 502);
  }
});
