import { z } from 'zod';
import { transitionVideoStatus } from './video-status';

interface Env {
  DB: D1Database;
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

const queueMessageSchema = z.object({
  videoId: z.string().min(1),
  r2Key: z.string().min(1),
});

async function sendToStream(env: Env, r2Key: string): Promise<string> {
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

export async function handleEncodingMessage(env: Env, body: unknown): Promise<void> {
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
