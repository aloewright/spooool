import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import { buildThumbnailCandidates } from './thumbnails';
import { VIDEO_STATUSES, canTransition, type VideoStatus } from './video-status';
import { triggerFanOut } from './channel-do';
import { sendNewUploadEmails, type NotificationDbEnv } from './notification-email';
import { waitUntilBackground } from './wait-until';

export const STREAM_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

const streamWebhookSchema = z.object({
  uid: z.string().min(1),
  status: z
    .object({
      state: z.string().min(1),
    })
    .passthrough(),
  playback: z
    .object({
      hls: z.string().url().optional(),
      dash: z.string().url().optional(),
    })
    .partial()
    .optional(),
  thumbnail: z.string().url().optional(),
  duration: z.number().nonnegative().optional(),
});

export type StreamWebhookPayload = z.infer<typeof streamWebhookSchema>;

// ALO-138: webhook reports always normalise to the canonical state
// machine alphabet. Any non-ready / non-error stream state means
// transcoding is mid-flight, which is `encoding` for us.
export type StreamVideoStatus = VideoStatus;

export function mapStreamState(state: string): StreamVideoStatus {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'ready') return 'ready';
  if (normalized === 'error') return 'failed';
  return 'encoding';
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array();
    out[i] = byte;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseSignatureHeader(header: string): { time: number; sig1: string } | null {
  const parts = header.split(',').map((p) => p.trim());
  let time: number | null = null;
  let sig1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'time') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) time = parsed;
    } else if (key === 'sig1') {
      sig1 = value;
    }
  }
  if (time === null || !sig1) return null;
  return { time, sig1 };
}

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_header' | 'stale_timestamp' | 'bad_signature' };

export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SignatureVerification> {
  if (!signatureHeader) return { ok: false, reason: 'missing_header' };
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(now - parsed.time) > STREAM_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${parsed.time}.${rawBody}`),
  );
  const expected = new Uint8Array(signed);
  const provided = hexToBytes(parsed.sig1);
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

export interface StreamWebhookEnv extends NotificationDbEnv {
  CF_STREAM_WEBHOOK_SECRET?: string;
  CHANNEL_SUBSCRIBER_DO?: DurableObjectNamespace;
}

export interface StreamWebhookDeps {
  now?: () => number;
}

export const handleStreamWebhook =
  (deps: StreamWebhookDeps = {}): MiddlewareHandler<{ Bindings: StreamWebhookEnv }> =>
  async (c: Context<{ Bindings: StreamWebhookEnv }>) => {
    const secret = c.env.CF_STREAM_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: 'Webhook not configured' }, 503);
    }

    const rawBody = await c.req.text();
    const verification = await verifyWebhookSignature(
      rawBody,
      c.req.header('Webhook-Signature'),
      secret,
      deps.now ? deps.now() : Math.floor(Date.now() / 1000),
    );
    if (!verification.ok) {
      return c.json({ error: 'Invalid signature', reason: verification.reason }, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = streamWebhookSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400);
    }

    const payload = parsed.data;
    const status = mapStreamState(payload.status.state);
    const playbackHls = payload.playback?.hls ?? null;
    const thumbnail = payload.thumbnail ?? null;
    const candidatesJson =
      status === 'ready'
        ? JSON.stringify(buildThumbnailCandidates(payload.uid, payload.duration))
        : null;

    // ALO-138: only flip the row when the webhook-derived status is a
    // legal successor of the row's current state (or the same state — we
    // tolerate idempotent retries). Stale webhook deliveries cannot drag
    // a `ready` row back to `encoding`.
    const allowedFrom = (VIDEO_STATUSES as readonly VideoStatus[]).filter((from) =>
      canTransition(from, status),
    );
    const placeholders = allowedFrom.map(() => '?').join(', ');

    const result = await c.env.DB.prepare(
      `UPDATE videos
       SET status = ?,
           stream_video_id = ?,
           playback_hls_url = COALESCE(?, playback_hls_url),
           thumbnail_url = COALESCE(?, thumbnail_url),
           thumbnail_candidates = COALESCE(?, thumbnail_candidates),
           updated_at = CURRENT_TIMESTAMP
       WHERE stream_video_id = ?
         AND status IN (${placeholders})`,
    )
      .bind(status, payload.uid, playbackHls, thumbnail, candidatesJson, payload.uid, ...allowedFrom)
      .run();

    const changes = (result.meta?.changes as number | undefined) ?? 0;
    if (changes === 0) {
      return c.json({ ok: true, matched: 0, status }, 202);
    }

    // Notify subscribers (in-app inbox + email) once the video is actually watchable.
    if (status === 'ready') {
      waitUntilBackground(c, (async () => {
        try {
          const video = await c.env.DB.prepare(
            `SELECT v.id, v.user_id, v.title, u.name AS channel_name
             FROM videos v LEFT JOIN user u ON u.id = v.user_id
             WHERE v.stream_video_id = ?`,
          ).bind(payload.uid).first<{ id: string; user_id: string; title: string; channel_name: string | null }>();
          if (!video) return;
          await Promise.all([
            triggerFanOut(c.env.CHANNEL_SUBSCRIBER_DO, {
              videoId: video.id,
              channelUserId: video.user_id,
            }),
            sendNewUploadEmails(c.env, {
              videoId: video.id,
              channelUserId: video.user_id,
              channelName: video.channel_name ?? '',
              videoTitle: video.title,
              origin: 'https://spooool.com',
            }),
          ]);
        } catch (err) {
          console.warn('[stream-webhook] subscriber notification failed', { uid: payload.uid, err: err instanceof Error ? err.message : String(err) });
        }
      })());
    }

    return c.json({ ok: true, matched: changes, status });
  };
