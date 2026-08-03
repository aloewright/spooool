import { z } from 'zod';
import { transitionVideoStatus } from './video-status';
import { getEncoderStub } from './encoder-container';

export interface SendToStreamEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  R2_BUCKET?: string;
}

// 30 min cap matches stream-upload.ts MAX_DURATION_SECONDS and Stream's basic ingest ceiling.
const STREAM_MAX_DURATION_SECONDS = 60 * 30;
const STREAM_ALLOWED_ORIGINS = ['spooool.com', 'www.spooool.com', '*.workers.dev'];

interface MinimalVideoRow {
  status: string;
  stream_video_id: string | null;
}

interface EncodingEnv extends SendToStreamEnv {
  DB: D1Database;
  STREAM_ENABLED?: string;
  ENCODE_CONTAINER?: DurableObjectNamespace;
}

const queueMessageSchema = z.object({
  videoId: z.string().min(1),
  r2Key: z.string().min(1),
});

export async function sendToStream(env: SendToStreamEnv, r2Key: string): Promise<string> {
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
        url: `r2://${env.R2_BUCKET ?? 'spooool-videos'}/${r2Key}`,
        requireSignedURLs: false,
        maxDurationSeconds: STREAM_MAX_DURATION_SECONDS,
        allowedOrigins: STREAM_ALLOWED_ORIGINS,
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

export async function handleEncodingMessage(env: EncodingEnv, body: unknown): Promise<void> {
  const parsed = queueMessageSchema.safeParse(body);
  if (!parsed.success) {
    return;
  }

  const { videoId, r2Key } = parsed.data;

  try {
    if (env.STREAM_ENABLED === 'true') {
      await transitionVideoStatus(env.DB, videoId, 'encoding');

      // Idempotency: if the queue message is retried after sendToStream() already
      // succeeded (e.g. worker crashed before ack), the row will already have a
      // stream_video_id. Skip the API call to avoid creating a duplicate Stream
      // video — the existing webhook delivery will complete the transition.
      const existing = await env.DB.prepare(
        'SELECT status, stream_video_id FROM videos WHERE id = ?',
      ).bind(videoId).first<MinimalVideoRow>();
      if (existing?.stream_video_id) return;

      const streamVideoId = await sendToStream(env, r2Key);
      // Stream now owns the row; the webhook will flip us to ready/failed.
      // Re-assert encoding so we capture the stream uid.
      await transitionVideoStatus(env.DB, videoId, 'encoding', { streamVideoId });
      return;
    }

    // R2+FFmpeg fallback: dispatch to EncoderContainer pool (ALO-136).
    if (!env.ENCODE_CONTAINER) {
      throw new Error('ENCODE_CONTAINER binding required for R2 encoding fallback');
    }
    await transitionVideoStatus(env.DB, videoId, 'encoding');
    const stub = getEncoderStub(env.ENCODE_CONTAINER, videoId);
    const res = await stub.fetch('https://encoder-container/encode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, r2Key }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      throw new Error(`Encoder container responded ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    await transitionVideoStatus(env.DB, videoId, 'failed');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Encoding failed for video ${videoId}: ${message}`);
  }
}
