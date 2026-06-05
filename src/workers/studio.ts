// AI Studio routes (E11). POST /api/studio/chat streams an @tanstack/ai chat
// response as SSE. Model selection + system prompt are server-controlled; the
// client only sends user/assistant turns. Generation is gateway-routed via
// ai-gateway.ts (transport mode owned there; default run-gateway).
// POST /api/studio/image generates an image via flux-1-schnell and stores it
// in R2 as a generated_asset; POST /api/videos/:id/thumbnail/from-asset
// copies a generated image asset into the thumbnail namespace.
import { Hono } from 'hono';
import { z } from 'zod';
import { chat, generateImage, toServerSentEventsResponse } from '@tanstack/ai';
import { gatewayChat, gatewayImage, DEFAULT_IMAGE_MODEL, type AiGatewayEnv, type AiGatewayMode } from './ai-gateway';
import type { AIBindingEnv } from './create-tools';
import { STUDIO_GEN_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';
import { getStorageUsage, hasRoomFor } from './storage-quota';

export interface StudioEnv extends AIBindingEnv {
  RATE_LIMITER?: DurableObjectNamespace;
  AI_GATEWAY_MODE?: AiGatewayMode;
  DB: D1Database;
  VIDEOS: R2Bucket;
  AI_GEN?: Queue<{ assetId: string; userId: string; prompt: string }>;
}

interface SessionUser { id: string; emailVerified: boolean }
type StudioVariables = { user: SessionUser | null };

const STUDIO_SYSTEM_PROMPT =
  "You are spooool's creative studio assistant. Help creators brainstorm video ideas, " +
  'scripts, titles, descriptions, and thumbnails. Be concise and practical.';

const chatBodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).min(1).max(50),
});

const IMAGE_MODEL = DEFAULT_IMAGE_MODEL;     // '@cf/black-forest-labs/flux-1-schnell'
const IMAGE_EXT = 'jpg';
const IMAGE_CONTENT_TYPE = 'image/jpeg';
const EST_USD_PER_IMAGE = 0.0013;            // order-of-magnitude placeholder (Workers AI bills Neurons)
const imageBodySchema = z.object({ prompt: z.string().min(1).max(2048) }); // flux maxLength

const fromAssetSchema = z.object({ asset_id: z.string().min(1) });
const videoBodySchema = z.object({ prompt: z.string().min(1).max(2048) });

export const studioRoutes = new Hono<{ Bindings: StudioEnv; Variables: StudioVariables }>();

studioRoutes.post('/api/studio/chat', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = chatBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  // Cast: AIBindingEnv.AI.gateway returns Promise<unknown> while AiGatewayEnv's
  // CloudflareAiGateway.run returns Promise<Response> — a tsc-only divergence
  // bridged at runtime by the real Ai binding. Same pattern as create-tools.ts.
  const stream = chat({
    adapter: gatewayChat(c.env as unknown as AiGatewayEnv),
    systemPrompts: [STUDIO_SYSTEM_PROMPT],
    messages: parsed.data.messages,
  });
  return toServerSentEventsResponse(stream);
});

studioRoutes.post('/api/studio/image', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = imageBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  let result;
  try {
    result = await generateImage({ adapter: gatewayImage(c.env as unknown as AiGatewayEnv, IMAGE_MODEL), prompt: parsed.data.prompt });
  } catch (err) {
    return c.json({ error: 'Image generation failed', detail: err instanceof Error ? err.message : String(err) }, 502);
  }
  const img = result.images[0];
  const b64 = img && 'b64Json' in img ? img.b64Json : undefined;
  if (!b64) return c.json({ error: 'Image generation returned no data' }, 502);

  // b64Json is raw image bytes already base64 — decode directly, do NOT JSON.parse.
  // See ai-gateway.ts "Inside a Worker" note in CLAUDE.md.
  const bin = atob(b64);
  const decoded = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
  const bytes = decoded.byteLength;

  const usage = await getStorageUsage(c.env, user.id);
  if (!hasRoomFor(usage, bytes)) {
    return c.json({ error: 'Storage quota exceeded.', code: 'storage_quota_exceeded', storage: usage }, 413);
  }

  const assetId = `a_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const r2Key = `studio/images/${assetId}.${IMAGE_EXT}`;
  await c.env.VIDEOS.put(r2Key, decoded, { httpMetadata: { contentType: IMAGE_CONTENT_TYPE } });

  const now = Date.now();
  const costId = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO generated_assets (id, user_id, kind, source, r2_key, stream_video_id, bytes, status, spec_json, error_message, project_id, created_at, updated_at) VALUES (?, ?, 'image', 'image_gen', ?, NULL, ?, 'ready', ?, NULL, NULL, ?, ?)`
    ).bind(assetId, user.id, r2Key, bytes, JSON.stringify({ model: IMAGE_MODEL, prompt: parsed.data.prompt }), now, now),
    c.env.DB.prepare(
      `INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, project_id, created_at) VALUES (?, ?, 'image_gen', 'dynamic/image_gen', ?, 1, 'images', ?, NULL, ?)`
    ).bind(costId, user.id, IMAGE_MODEL, EST_USD_PER_IMAGE, now),
  ]);

  // dataUrl lets the panel preview immediately (studio/images/* has no public GET route).
  return c.json({ assetId, r2Key, bytes, dataUrl: `data:${IMAGE_CONTENT_TYPE};base64,${b64}` }, 201);
});

studioRoutes.post('/api/studio/video', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  if (!c.env.AI_GEN) return c.json({ error: 'Video generation is unavailable.' }, 503);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = videoBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const assetId = `a_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO generated_assets (id, user_id, kind, source, r2_key, stream_video_id, bytes, status, spec_json, error_message, project_id, created_at, updated_at) VALUES (?, ?, 'video', 'video_gen', NULL, NULL, 0, 'queued', ?, NULL, NULL, ?, ?)`,
  )
    .bind(assetId, user.id, JSON.stringify({ model: 'google/veo-3.1', prompt: parsed.data.prompt }), now, now)
    .run();

  try {
    await c.env.AI_GEN.send({ assetId, userId: user.id, prompt: parsed.data.prompt });
  } catch (err) {
    await c.env.DB.prepare(`UPDATE generated_assets SET status='failed', error_message=?, updated_at=? WHERE id=? AND user_id=?`)
      .bind('Failed to enqueue generation', Date.now(), assetId, user.id).run();
    return c.json({ error: 'Failed to enqueue video generation. Try again.' }, 503);
  }

  return c.json({ assetId, status: 'queued' }, 202);
});

studioRoutes.post('/api/videos/:id/thumbnail/from-asset', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const videoId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = fromAssetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body' }, 400);

  const video = await c.env.DB.prepare(
    `SELECT id, user_id FROM videos WHERE id = ? AND deleted_at IS NULL`
  ).bind(videoId).first<{ id: string; user_id: string }>();
  if (!video) return c.json({ error: 'Not found' }, 404);
  if (video.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const asset = await c.env.DB.prepare(
    `SELECT id, r2_key FROM generated_assets WHERE id = ? AND user_id = ? AND kind = 'image' AND status = 'ready'`
  ).bind(parsed.data.asset_id, user.id).first<{ id: string; r2_key: string }>();
  if (!asset || !asset.r2_key) return c.json({ error: 'Asset not found' }, 404);

  const obj = await c.env.VIDEOS.get(asset.r2_key);
  if (!obj) return c.json({ error: 'Asset object missing' }, 404);

  const objectName = `${crypto.randomUUID()}.jpg`;
  const dest = `thumbnails/${user.id}/${videoId}/${objectName}`;
  await c.env.VIDEOS.put(dest, obj.body, { httpMetadata: { contentType: 'image/jpeg' } });

  const url = new URL(c.req.url);
  url.pathname = `/api/thumbnails/${user.id}/${videoId}/${objectName}`;
  url.search = '';
  const thumbnailUrl = url.toString();   // ABSOLUTE — required by isOwnedR2ThumbnailUrl + OG/oembed

  await c.env.DB.prepare(
    `UPDATE videos SET thumbnail_url = ?, updated_at = ? WHERE id = ?`
  ).bind(thumbnailUrl, Date.now(), videoId).run();

  return c.json({ id: videoId, thumbnail_url: thumbnailUrl });
});
