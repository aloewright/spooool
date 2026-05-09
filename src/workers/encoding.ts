import { z } from 'zod';
import { transitionVideoStatus } from './video-status';

export interface EncodingEnv {
  DB: D1Database;
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  // ALO-136: external FFmpeg encoder service (Cloudflare Container or
  // self-hosted Worker → Container). When set, the queue handler POSTs the
  // job there instead of leaving the row queued. The encoder downloads from
  // R2, transcodes to HLS variants, uploads results back to R2, and posts
  // back to /api/webhooks/ffmpeg with a signed payload to flip the row to
  // ready/failed.
  FFMPEG_ENCODER_URL?: string;
  // Optional shared HMAC secret. When set we sign the outbound POST and the
  // encoder is expected to verify; the inbound webhook also requires the
  // same secret to be configured. When unset the dispatch still happens
  // (encoder can rely on Cloudflare Access or network isolation), but the
  // webhook is unauthenticated and refuses to apply updates.
  FFMPEG_ENCODER_SECRET?: string;
}

const queueMessageSchema = z.object({
  videoId: z.string().min(1),
  r2Key: z.string().min(1),
});

async function sendToStream(env: EncodingEnv, r2Key: string): Promise<string> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_STREAM_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('Stream is enabled but missing account/token configuration');
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: `r2://${r2Key}`,
        requireSignedURLs: false,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Stream API failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: { uid?: string };
  };
  const streamId = data.result?.uid;
  if (!streamId) {
    throw new Error('Stream API response missing video uid');
  }
  return streamId;
}

// The R2 key prefix the FFmpeg encoder writes its HLS output under.
// Mirrors the existing `<userId>/<videoId>/<filename>` source layout so a
// bucket browser groups source + HLS for the same upload together.
export function hlsOutputPrefix(r2Key: string): string {
  // Source key looks like `<userId>/<videoId>/<filename>`. Drop the
  // filename and append `hls/` so multiple re-encodes overwrite cleanly.
  const lastSlash = r2Key.lastIndexOf('/');
  const dir = lastSlash >= 0 ? r2Key.slice(0, lastSlash) : r2Key;
  return `${dir}/hls/`;
}

async function signEncoderPayload(secret: string, body: string, time: number): Promise<string> {
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
    new TextEncoder().encode(`${time}.${body}`),
  );
  return Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function dispatchFfmpegJob(
  env: EncodingEnv,
  videoId: string,
  r2Key: string,
): Promise<void> {
  const url = env.FFMPEG_ENCODER_URL;
  if (!url) {
    // No encoder configured — leave the row in `encoding`. An operator can
    // enqueue a re-run once the encoder is wired, or transition the row to
    // `failed` manually. We don't auto-fail because that would mark every
    // queued upload as broken on a fresh deploy before the Container is up.
    return;
  }

  const outputPrefix = hlsOutputPrefix(r2Key);
  const body = JSON.stringify({
    videoId,
    sourceR2Key: r2Key,
    outputR2Prefix: outputPrefix,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (env.FFMPEG_ENCODER_SECRET) {
    const time = Math.floor(Date.now() / 1000);
    const sig = await signEncoderPayload(env.FFMPEG_ENCODER_SECRET, body, time);
    headers['x-ffmpeg-signature'] = `time=${time},sig1=${sig}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`FFmpeg encoder dispatch failed: ${response.status} ${text}`.trim());
  }
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

    // ALO-136: R2 + FFmpeg fallback encoding path. Mark the row encoding
    // and dispatch the job to the external encoder. The encoder POSTs back
    // to /api/webhooks/ffmpeg when done, which flips the row to
    // ready/failed and stores the HLS playback path.
    await transitionVideoStatus(env.DB, videoId, 'encoding');
    await dispatchFfmpegJob(env, videoId, r2Key);
  } catch (error) {
    await transitionVideoStatus(env.DB, videoId, 'failed');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Encoding failed for video ${videoId}: ${message}`);
  }
}
