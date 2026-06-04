// ai-video-consumer.ts — queue consumer for AI_GEN (Veo 3.1 generative video b-roll).
//
// IMPORTANT: A Cloudflare Queue consumer executes inside the same Worker runtime
// as the HTTP request handler. It is NOT a Node.js context and does NOT go through
// the CF-2019 compat layer. Therefore compat-fetch to a gateway URL is FORBIDDEN
// here — the runtime rejects it with the same CF-2019 error you'd get in any Worker.
//
// The correct, Worker-safe, gateway-observable pattern is:
//   env.AI.run('google/veo-3.1', input, { gateway: { id: 'x' } })
// This routes through AI Gateway for observability + cost analytics while staying
// entirely within the Worker binding surface. No compat fetch, no provider SDK.

import { z } from 'zod';
import { GATEWAY_ID } from './ai-gateway';

const VEO_MODEL = 'google/veo-3.1';

// Veo 3.1 order-of-magnitude price per generated second (placeholder; verify in
// the CF AI Gateway billing dashboard — final pricing is account/plan-dependent).
const VEO_EST_USD_PER_SECOND = 0.0;

interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    opts?: { gateway?: { id: string; skipCache?: boolean } },
  ): Promise<unknown>;
}

export interface AiVideoEnv {
  AI: AiBinding;
  DB: D1Database;
  VIDEOS: R2Bucket;
  // Stream REST API creds — optional; when present the generated video is also
  // submitted to Cloudflare Stream so the player can stream it via HLS.
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

const messageSchema = z.object({
  assetId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string().min(1),
  duration: z.number().positive().optional(),
  aspect_ratio: z.string().optional(),
  resolution: z.string().optional(),
  generate_audio: z.boolean().optional(),
  projectId: z.string().optional(),
});

export type AiGenMessage = z.infer<typeof messageSchema>;

type VeoRunResult = {
  result?: { video?: string };
};

async function submitToStream(
  env: Pick<AiVideoEnv, 'CLOUDFLARE_ACCOUNT_ID' | 'CF_STREAM_API_TOKEN'>,
  r2Key: string,
): Promise<string | undefined> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_STREAM_API_TOKEN;
  if (!accountId || !apiToken) return undefined;

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `r2://${r2Key}`, requireSignedURLs: false }),
    },
  );
  if (!resp.ok) {
    console.warn('[ai-video-consumer] Stream submission non-2xx', { status: resp.status, r2Key });
    return undefined;
  }
  const data = (await resp.json()) as { result?: { uid?: string } };
  return data.result?.uid;
}

export async function handleAiGenMessage(env: AiVideoEnv, body: unknown): Promise<void> {
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) {
    // Malformed message — ack silently so it doesn't loop through retries.
    return;
  }

  const { assetId, userId, prompt, duration, aspect_ratio, resolution, generate_audio, projectId } =
    parsed.data;
  const now = Date.now();

  await env.DB.prepare('UPDATE generated_assets SET status=?, updated_at=? WHERE id=?')
    .bind('processing', now, assetId)
    .run();

  try {
    // Worker-safe binding+gateway call. Queue consumer = Worker = CF-2019;
    // compat-fetch to the gateway endpoint is NOT used (see module header).
    const raw = (await env.AI.run(
      VEO_MODEL,
      { prompt, duration, aspect_ratio, resolution, generate_audio },
      { gateway: { id: GATEWAY_ID } },
    )) as VeoRunResult;

    const videoUrl = raw?.result?.video;
    if (!videoUrl) {
      throw new Error('Veo 3.1 response missing result.video URL');
    }

    // Stage to R2: fetch the AI-hosted video and write to our VIDEOS bucket.
    const fetchResp = await fetch(videoUrl);
    if (!fetchResp.ok) {
      throw new Error(`Failed to fetch generated video (${fetchResp.status}): ${videoUrl}`);
    }
    const videoBytes = await fetchResp.arrayBuffer();
    const r2Key = `studio/video/${assetId}.mp4`;
    await env.VIDEOS.put(r2Key, videoBytes, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    // Optionally submit to Cloudflare Stream via REST API for HLS playback.
    let streamVideoId: string | null = null;
    if (env.STREAM_ENABLED === 'true') {
      streamVideoId = (await submitToStream(env, r2Key)) ?? null;
    }

    const readyAt = Date.now();
    await env.DB.prepare(
      'UPDATE generated_assets SET status=?, r2_key=?, stream_video_id=?, bytes=?, updated_at=? WHERE id=?',
    )
      .bind('ready', r2Key, streamVideoId, videoBytes.byteLength, readyAt, assetId)
      .run();

    // Append-only cost ledger. unit_kind='seconds' per Veo 3.1 billing model.
    const generatedSeconds = duration ?? 5;
    await env.DB.prepare(
      'INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, project_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        crypto.randomUUID(),
        userId,
        'video_gen',
        '/api/studio/video',
        VEO_MODEL,
        generatedSeconds,
        'seconds',
        generatedSeconds * VEO_EST_USD_PER_SECOND,
        projectId ?? null,
        readyAt,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      'UPDATE generated_assets SET status=?, error_message=?, updated_at=? WHERE id=?',
    )
      .bind('failed', message, Date.now(), assetId)
      .run();
    // Re-throw so the queue runtime can retry per [[queues.consumers]] max_retries.
    throw new Error(`AI video generation failed for asset ${assetId}: ${message}`);
  }
}
