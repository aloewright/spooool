import { z } from 'zod';
import { transitionVideoStatus } from './video-status';

export interface EncodingEnv {
  DB: D1Database;
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  // Public origin used to build the source URL Cloudflare Stream pulls
  // from. Falls back to BETTER_AUTH_URL or workers.dev URL at deploy time.
  STREAM_SOURCE_ORIGIN?: string;
  BETTER_AUTH_URL?: string;
  // HMAC secret used to sign one-time R2 source URLs. Reuses the webhook
  // secret so we don't need a second piece of config — both values rotate
  // together on the Stream side.
  CF_STREAM_WEBHOOK_SECRET?: string;
}

const queueMessageSchema = z.object({
  videoId: z.string().min(1),
  r2Key: z.string().min(1),
});

// Stream needs ~1 minute to fetch the source object after it accepts the copy
// job; we sign for an hour so a slow CDN warm-up still resolves.
export const STREAM_SOURCE_URL_TTL_SECONDS = 60 * 60;

interface StreamCopyResponse {
  success?: boolean;
  result?: { uid?: string };
  errors?: { code?: number; message?: string }[];
}

function pickOrigin(env: EncodingEnv): string {
  const origin = env.STREAM_SOURCE_ORIGIN ?? env.BETTER_AUTH_URL;
  if (!origin) {
    throw new Error(
      'STREAM_SOURCE_ORIGIN / BETTER_AUTH_URL must be set so Cloudflare Stream can fetch the R2 source URL',
    );
  }
  return origin.replace(/\/+$/, '');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Build a publicly fetchable HTTPS URL that Cloudflare Stream can pull the
 * source object from. The URL is signed with an HMAC over `${exp}.${r2Key}`
 * so a leaked link can't be replayed past `exp`. Stream copies the bytes
 * once and stores its own copy server-side.
 */
export async function buildStreamSourceUrl(
  env: EncodingEnv,
  r2Key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const secret = env.CF_STREAM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('CF_STREAM_WEBHOOK_SECRET must be set to sign Stream source URLs');
  }
  const origin = pickOrigin(env);
  const exp = nowSeconds + STREAM_SOURCE_URL_TTL_SECONDS;
  const sig = await hmacHex(secret, `${exp}.${r2Key}`);
  const url = new URL(`${origin}/api/internal/stream-source`);
  url.searchParams.set('key', r2Key);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export async function sendToStream(env: EncodingEnv, r2Key: string): Promise<string> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_STREAM_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('Stream is enabled but missing account/token configuration');
  }

  const sourceUrl = await buildStreamSourceUrl(env, r2Key);

  // /stream/copy takes an HTTPS URL and pulls the bytes server-side. The
  // R2 source endpoint above feeds those bytes from our own bucket.
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: sourceUrl,
        requireSignedURLs: false,
        meta: { r2Key },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stream API failed: ${response.status} ${text}`);
  }

  const data = (await response.json().catch(() => ({}))) as StreamCopyResponse;
  const streamId = data.result?.uid;
  if (!streamId) {
    const detail = data.errors?.[0]?.message ?? 'unknown error';
    throw new Error(`Stream API response missing video uid (${detail})`);
  }
  return streamId;
}

export async function handleEncodingMessage(env: EncodingEnv, body: unknown): Promise<void> {
  const parsed = queueMessageSchema.safeParse(body);
  if (!parsed.success) {
    return;
  }

  const { videoId, r2Key } = parsed.data;

  try {
    if (env.STREAM_ENABLED === 'true') {
      await transitionVideoStatus(env.DB, videoId, 'encoding');
      const streamVideoId = await sendToStream(env, r2Key);
      // Stream now owns the row; the webhook will flip us to ready/failed.
      // Re-assert encoding so we capture the stream uid.
      await transitionVideoStatus(env.DB, videoId, 'encoding', { streamVideoId });
      return;
    }

    // No Stream — leave queued for the R2+FFmpeg fallback path (ALO-136).
  } catch (error) {
    await transitionVideoStatus(env.DB, videoId, 'failed');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Encoding failed for video ${videoId}: ${message}`);
  }
}

/**
 * Verify the HMAC on a stream-source URL. Used by the worker route that
 * serves R2 bytes to Cloudflare Stream — see `streamSourceRoutes`.
 */
export async function verifyStreamSourceSignature(
  env: EncodingEnv,
  r2Key: string,
  exp: number,
  sig: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: 'expired' | 'bad_signature' | 'missing_secret' }> {
  const secret = env.CF_STREAM_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!Number.isFinite(exp) || exp < nowSeconds) return { ok: false, reason: 'expired' };
  const expected = await hmacHex(secret, `${exp}.${r2Key}`);
  if (expected.length !== sig.length) return { ok: false, reason: 'bad_signature' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
