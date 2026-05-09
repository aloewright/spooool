// ALO-136: completion callback for the R2 + FFmpeg fallback encoder.
//
// When Cloudflare Stream is disabled, the encoding queue handler dispatches
// a job to a containerized FFmpeg worker. That worker downloads the source
// from R2, transcodes it into HLS variants (master.m3u8 + per-rendition
// playlists + .ts segments) under a stable prefix in the same R2 bucket,
// then POSTs here to flip the videos row to `ready` and record the prefix
// where the manifest lives.
//
// Mirrors src/workers/stream-webhook.ts in shape — same HMAC signature
// header, same canonical-state transition guard — so the operational
// surface is consistent regardless of which encoding path produced the
// playback URL.

import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import { VIDEO_STATUSES, canTransition, type VideoStatus } from './video-status';

export const FFMPEG_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

const ffmpegWebhookSchema = z.object({
  videoId: z.string().min(1),
  status: z.enum(['ready', 'failed']),
  // R2 key prefix the encoder wrote the master playlist + variant
  // playlists + segments under. Required when status is 'ready'.
  // Example: `<userId>/<videoId>/hls/`. Always trailing-slash terminated;
  // we normalise on input to avoid empty-segment URLs at serve time.
  outputR2Prefix: z.string().min(1).optional(),
  // File name of the master playlist within the prefix. Defaults to
  // `master.m3u8` if the encoder doesn't override it.
  masterPlaylist: z.string().min(1).optional(),
  // Optional reason string surfaced by the encoder when status='failed'.
  // Logged but not persisted on the row — failure detail lives in encoder
  // logs / Sentry, not in D1.
  reason: z.string().max(500).optional(),
});

export type FfmpegWebhookPayload = z.infer<typeof ffmpegWebhookSchema>;

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

export type FfmpegSignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing_header' | 'malformed_header' | 'stale_timestamp' | 'bad_signature';
    };

export async function verifyFfmpegWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<FfmpegSignatureVerification> {
  if (!signatureHeader) return { ok: false, reason: 'missing_header' };
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(now - parsed.time) > FFMPEG_WEBHOOK_TOLERANCE_SECONDS) {
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

// Trailing slash matters: HLS playlists reference relative URLs to
// segments/variant playlists, and serve-time joins do `${prefix}${path}`.
// Normalise so callers don't have to remember.
export function normaliseHlsPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return `${trimmed}/`;
}

export interface FfmpegWebhookEnv {
  DB: D1Database;
  FFMPEG_ENCODER_SECRET?: string;
}

export interface FfmpegWebhookDeps {
  now?: () => number;
}

export const handleFfmpegWebhook =
  (deps: FfmpegWebhookDeps = {}): MiddlewareHandler<{ Bindings: FfmpegWebhookEnv }> =>
  async (c: Context<{ Bindings: FfmpegWebhookEnv }>) => {
    const secret = c.env.FFMPEG_ENCODER_SECRET;
    if (!secret) {
      return c.json({ error: 'Webhook not configured' }, 503);
    }

    const rawBody = await c.req.text();
    const verification = await verifyFfmpegWebhookSignature(
      rawBody,
      c.req.header('x-ffmpeg-signature'),
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

    const parsed = ffmpegWebhookSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'Invalid payload', details: parsed.error.flatten() }, 400);
    }

    const { videoId, status } = parsed.data;
    let playbackHlsPath: string | null = null;
    if (status === 'ready') {
      if (!parsed.data.outputR2Prefix) {
        return c.json(
          { error: 'outputR2Prefix is required when status is "ready"' },
          400,
        );
      }
      const prefix = normaliseHlsPrefix(parsed.data.outputR2Prefix);
      const masterFile = parsed.data.masterPlaylist?.trim() || 'master.m3u8';
      // `playback_hls_path` stores the relative R2 key of the master
      // playlist. The serve route at /api/videos/:id/hls/* re-derives the
      // segment keys by stripping `master.m3u8` to the prefix and joining
      // with the requested sub-path.
      playbackHlsPath = `${prefix}${masterFile}`;
    }

    // ALO-138: gate the write on the canonical state machine. A late
    // webhook arriving after a re-encode pushed the row past `ready` (or
    // back to `queued` on retry) is dropped rather than dragging the
    // lifecycle backwards.
    const allowedFrom = (VIDEO_STATUSES as readonly VideoStatus[]).filter((from) =>
      canTransition(from, status),
    );
    const placeholders = allowedFrom.map(() => '?').join(', ');

    const result = await c.env.DB.prepare(
      `UPDATE videos
       SET status = ?,
           playback_hls_path = COALESCE(?, playback_hls_path),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status IN (${placeholders})`,
    )
      .bind(status, playbackHlsPath, videoId, ...allowedFrom)
      .run();

    const changes = (result.meta?.changes as number | undefined) ?? 0;
    if (changes === 0) {
      return c.json({ ok: true, matched: 0, status }, 202);
    }
    return c.json({ ok: true, matched: changes, status });
  };
