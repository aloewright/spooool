// AI-Gen queue consumer: handles generative video jobs for AI Studio (ALO-647).
//
// This runs inside a Cloudflare Worker (queue consumer IS a Worker), so we use
// env.AI.run(..., { gateway: { id: 'x' } }) — the only path that actually works
// in this account:
//   - env.AI.run("dynamic/video_gen", ...) → CF error 404 "Model not found" (dynamic
//     routes are NOT resolvable through env.AI.run()).
//   - env.AI.gateway(id).run({ provider:"compat", ... }) → skips fallback chain on
//     this account (gateway binding bug, upstream not fixed yet).
//   - fetch() to the gateway HTTPS endpoint from inside a Worker → CF error 2019
//     (Compatibility restriction — requests from Workers to the gateway REST endpoint
//     are blocked before the gateway processes them).
// Therefore: pass the model id directly with { gateway: { id: 'x' } } so Veo calls
// are still observable and cached in AI Gateway. See CLAUDE.md "Inside a Worker".
//
// IMPORTANT: handleAiGenMessage NEVER throws. On any error it updates
// generated_assets to status='failed' and returns normally so the queue
// handler always acks the message. Generative video must NOT auto-retry
// because each failed attempt re-bills the Veo API.

import { z } from 'zod';
import { sendToStream } from './encoding';
import { writeAiCost } from './ai-costs';

// Order-of-magnitude cost placeholder (Workers AI Neurons → USD).
// Veo 3.1 pricing: ~$0.40 per 8 s clip at 720p (update when CF publishes exact rate).
const EST_USD_PER_VIDEO = 0.40;

export interface AiGenEnv {
  AI: { run(model: string, input: unknown, opts?: { gateway?: { id: string } }): Promise<unknown> };
  VIDEOS: R2Bucket;
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

const bodySchema = z.object({
  assetId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string().min(1),
});

export async function handleAiGenMessage(env: AiGenEnv, body: unknown): Promise<void> {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    // Malformed message — silently drop (no asset row to update).
    console.warn('[ai-gen] malformed message body', { issues: parsed.error.issues });
    return;
  }

  const { assetId, userId, prompt } = parsed.data;

  try {
    // ── 1. Generate video via Veo ────────────────────────────────────────────
    // Consumer is a Worker → use env.AI.run with gateway opt (compat fetch → CF-2019).
    const raw = await env.AI.run(
      'google/veo-3.1',
      { prompt, duration: '8s', aspect_ratio: '16:9', resolution: '720p', generate_audio: true },
      { gateway: { id: 'x' } },
    );
    const aiResponse = raw as { result?: { video?: string } } | undefined;
    const videoUrl = aiResponse?.result?.video;
    if (!videoUrl) {
      throw new Error('[ai-gen] Veo response missing result.video URL');
    }

    // ── 2. Fetch video bytes ──────────────────────────────────────────────────
    const resp = await fetch(videoUrl);
    if (!resp.ok) {
      throw new Error(`[ai-gen] fetch video URL failed: ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const bytes = buf.byteLength;

    // ── 3. Store in R2 ───────────────────────────────────────────────────────
    const r2Key = `studio/video/${assetId}.mp4`;
    await env.VIDEOS.put(r2Key, buf, { httpMetadata: { contentType: 'video/mp4' } });

    // ── 4. Best-effort Cloudflare Stream ingest ───────────────────────────────
    // Stream failure is non-fatal: video bytes are safely in R2 regardless.
    let streamVideoId: string | null = null;
    try {
      streamVideoId = await sendToStream(env, r2Key);
    } catch (e) {
      console.warn('[ai-gen] stream ingest failed — video saved to R2 but not ingested to Stream', {
        assetId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // ── 5. Mark asset ready ───────────────────────────────────────────────────
    await env.DB.prepare(
      "UPDATE generated_assets SET status='ready', bytes=?, r2_key=?, stream_video_id=?, updated_at=? WHERE id=? AND user_id=?",
    )
      .bind(bytes, r2Key, streamVideoId, Date.now(), assetId, userId)
      .run();

    // ── 6. Record AI cost ─────────────────────────────────────────────────────
    await writeAiCost(env, {
      userId,
      op: 'video_gen',
      route: 'dynamic/video_gen',
      model: 'google/veo-3.1',
      units: 8,
      unitKind: 'seconds',
      estUsd: EST_USD_PER_VIDEO,
    });
  } catch (err) {
    // On any failure: mark asset failed and return normally (do NOT rethrow).
    // Rethrowing would cause the queue handler to retry the message, which
    // would re-bill Veo. We eat the error here and surface it via the DB row.
    console.error('[ai-gen] video generation failed', {
      assetId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await env.DB.prepare(
        "UPDATE generated_assets SET status='failed', error_message=?, updated_at=? WHERE id=? AND user_id=?",
      )
        .bind(errorMessage, Date.now(), assetId, userId)
        .run();
    } catch (dbErr) {
      console.error('[ai-gen] failed to update asset status to failed', {
        assetId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  }
}
