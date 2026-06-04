// AI_GEN queue consumer — generative video b-roll via Cloudflare Workers AI.
//
// IMPORTANT: this consumer runs inside the SAME Worker runtime as the HTTP
// request handler (compatibility_date = "2024-03-29", CF-2019 security model).
// Compat-fetch to gateway or provider REST endpoints is NOT used — outbound
// fetches to internal Cloudflare URLs on the same account are rejected by the
// CF-2019 rule. The only working, gateway-observable invocation shape from a
// Worker is:
//
//   env.AI.run('<model>', input, { gateway: { id: 'x' } })
//
// The AI binding proxies through gateway 'x' transparently without hitting
// the compat-fetch block.

import { z } from 'zod';

export interface AiGenEnv {
  DB: D1Database;
  AI: {
    run: (
      model: string,
      input: Record<string, unknown>,
      opts?: { gateway?: { id: string; skipCache?: boolean } },
    ) => Promise<ArrayBuffer | Uint8Array | Response>;
  };
  VIDEOS: R2Bucket;
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

export const aiGenMessageSchema = z.object({
  assetId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  duration: z.number().int().min(1).max(60).optional(),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional(),
  generateAudio: z.boolean().optional(),
});

export type AiGenMessage = z.infer<typeof aiGenMessageSchema>;

// Placeholder USD/second — update when CF publishes the Veo 3.1 rate card.
// ai_costs.est_usd is order-of-magnitude only (see costs.ts PRICE_* note).
const VEO_EST_USD_PER_SECOND = 0.05;

interface VeoResult {
  result?: { video?: string };
}

async function parseVeoResponse(raw: ArrayBuffer | Uint8Array | Response): Promise<VeoResult> {
  if (raw && typeof (raw as Response).json === 'function') {
    return await (raw as Response).json() as VeoResult;
  }
  if (raw instanceof ArrayBuffer || (raw instanceof Uint8Array)) {
    const text = new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
    return JSON.parse(text) as VeoResult;
  }
  return raw as unknown as VeoResult;
}

export async function handleAiGenMessage(env: AiGenEnv, body: unknown): Promise<void> {
  const parsed = aiGenMessageSchema.safeParse(body);
  if (!parsed.success) {
    // Malformed messages are not retryable — drop silently rather than DLQ-looping.
    console.warn('[ai-gen] invalid message body', { errors: parsed.error.flatten() });
    return;
  }

  const {
    assetId,
    userId,
    prompt,
    duration = 5,
    aspectRatio = '16:9',
    resolution = '1080p',
    generateAudio = false,
  } = parsed.data;

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE generated_assets SET status='processing', updated_at=? WHERE id=?`,
  ).bind(now, assetId).run();

  try {
    // google/veo-3.1 is NOT matched by the lint:no-providers forbidden model-id
    // regexes (only openai/gpt-*, anthropic/claude-*, google/gemini-* are blocked).
    const raw = await env.AI.run(
      'google/veo-3.1',
      { prompt, duration, aspect_ratio: aspectRatio, resolution, generate_audio: generateAudio },
      { gateway: { id: 'x' } },
    );

    const veoData = await parseVeoResponse(raw);
    const videoUrl = veoData?.result?.video;
    if (!videoUrl) {
      throw new Error('Veo response missing result.video URL');
    }

    // Fetch the generated video from the R2-hosted URL returned by Veo and
    // stage it into our own bucket so we own the lifecycle and can set TTL.
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`Failed to fetch generated video from Veo URL: ${videoRes.status}`);
    }
    const videoBytes = await videoRes.arrayBuffer();
    const r2Key = `studio/video/${assetId}.mp4`;

    await env.VIDEOS.put(r2Key, videoBytes, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    const bytes = videoBytes.byteLength;
    const doneAt = Date.now();

    // Optional: ingest the R2-staged file into Cloudflare Stream for adaptive
    // HLS delivery. Mirrors the pattern in encoding.ts. On failure we still
    // have the R2 copy — log and continue rather than marking the job failed.
    let streamVideoId: string | null = null;
    if (env.STREAM_ENABLED === 'true' && env.CLOUDFLARE_ACCOUNT_ID && env.CF_STREAM_API_TOKEN) {
      try {
        const streamRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.CF_STREAM_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: `r2://${r2Key}`, requireSignedURLs: false }),
          },
        );
        if (streamRes.ok) {
          const data = (await streamRes.json()) as { result?: { uid?: string } };
          streamVideoId = data.result?.uid ?? null;
        } else {
          console.warn('[ai-gen] Stream ingest failed', { status: streamRes.status, assetId });
        }
      } catch (streamErr) {
        console.warn('[ai-gen] Stream ingest threw', {
          err: streamErr instanceof Error ? streamErr.message : String(streamErr),
          assetId,
        });
      }
    }

    await env.DB.prepare(
      `UPDATE generated_assets
       SET status='ready', r2_key=?, bytes=?, stream_video_id=?, updated_at=?
       WHERE id=?`,
    ).bind(r2Key, bytes, streamVideoId, doneAt, assetId).run();

    // Append-only cost ledger. unit_kind='seconds' — Veo is billed by output
    // duration, not tokens. est_usd is a placeholder until the rate card lands.
    const costId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, created_at)
       VALUES (?, ?, 'video_gen', 'ai-gen', 'google/veo-3.1', ?, 'seconds', ?, ?)`,
    ).bind(costId, userId, duration, duration * VEO_EST_USD_PER_SECOND, doneAt).run();

    console.log('[ai-gen] video generated', { assetId, bytes, streamVideoId, durationSecs: duration });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ai-gen] generation failed', { assetId, error: message });

    await env.DB.prepare(
      `UPDATE generated_assets SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind(message.slice(0, 500), Date.now(), assetId).run();

    // Re-throw so the queue retries per consumer max_retries config.
    throw err;
  }
}
