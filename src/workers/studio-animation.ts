import { chat, generateImage, generateSpeech } from '@tanstack/ai';
import { Hono } from 'hono';
import { STUDIO_GEN_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';
import {
  gatewayChat,
  gatewayImage,
  gatewayTts,
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TTS_MODEL,
  type AiGatewayEnv,
  type AiGatewayMode,
} from './ai-gateway';
import { aiCostStatement, writeAiCost } from './ai-costs';
import { submitRenderJob, type RenderEnv } from './render';
import {
  animationRequestSchema,
  animationProjectOutputSchema,
  parseAnimationProjectSpec,
  dimensionsForAspectRatio,
  extractAssetPlaceholders,
  extractConcreteAssetRefs,
  rewriteAssetPlaceholders,
  type AnimationAssetRef,
  type AnimationProjectSpec,
  type AnimationRequest,
} from './animation-scene-schema';
import { getStorageUsage, hasRoomFor } from './storage-quota';

export interface StudioAnimationEnv extends RenderEnv {
  RATE_LIMITER?: DurableObjectNamespace;
  AI_GATEWAY_MODE?: AiGatewayMode;
  DB: D1Database;
  VIDEOS: R2Bucket;
}

type SessionUser = { id: string; emailVerified: boolean };
type Variables = { user: SessionUser | null };

export const studioAnimationRoutes = new Hono<{ Bindings: StudioAnimationEnv; Variables: Variables }>();

const EST_USD_ANIMATION_PLAN = 0.002;
const EST_USD_PER_IMAGE = 0.0013;
const EST_USD_TTS_BASE = 0.001;
const EST_USD_RENDER_BASE = 0.01;
const MAX_GENERATED_IMAGES = 4;
const IMAGE_EXT = 'jpg';
const IMAGE_CONTENT_TYPE = 'image/jpeg';

function voiceToSpeaker(voiceover: 'warm' | 'neutral' | 'energetic'): string {
  if (voiceover === 'warm') return 'asteria-en';
  if (voiceover === 'energetic') return 'orion-en';
  return 'arcas-en';
}

function targetDurationFrames(durationSeconds: AnimationRequest['durationSeconds']): number {
  return durationSeconds * 30;
}

/**
 * Compute the final frame covered by the plan's scenes (max of startFrame +
 * durationFrames). Returns null when scenes are missing or non-numeric so the
 * caller leaves durationFrames untouched and lets schema validation report it.
 */
function planSceneCoverage(plan: { scenes?: unknown }): number | null {
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) return null;
  let end = 0;
  for (const scene of plan.scenes) {
    if (!scene || typeof scene !== 'object') return null;
    const start = (scene as { startFrame?: unknown }).startFrame;
    const duration = (scene as { durationFrames?: unknown }).durationFrames;
    if (typeof start !== 'number' || typeof duration !== 'number') return null;
    end = Math.max(end, start + duration);
  }
  return Number.isFinite(end) && end > 0 ? end : null;
}

function normalizePlanDimensions(
  plan: AnimationProjectSpec,
  aspectRatio: AnimationRequest['aspectRatio'],
): AnimationProjectSpec {
  const dims = dimensionsForAspectRatio(aspectRatio);
  // The model often reports a durationFrames that disagrees with its own scene
  // coverage. Width/height are already overridden to authoritative values; do the
  // same for durationFrames so a contiguous plan isn't rejected over an off-by-N total.
  const coverage = planSceneCoverage(plan as { scenes?: unknown });
  return parseAnimationProjectSpec({
    ...plan,
    width: dims.width,
    height: dims.height,
    ...(coverage !== null ? { durationFrames: coverage } : {}),
  });
}

function buildAnimationSystemPrompt(useGeneratedImages: boolean): string {
  return [
    'Return JSON only matching the AnimationProjectSpec schema.',
    'Do not generate code, React, CSS, or commentary.',
    'Use fps=30 and frame-driven motion specs only.',
    'Keep motion physically plausible with easing values linear, easeOut, easeInOut, or spring.',
    'Scenes must be contiguous starting at frame 0 with no gaps or overlaps.',
    'Use hex or rgb()/rgba() colors only — no named CSS colors.',
    useGeneratedImages
      ? 'For image layers use asset placeholders like asset:hero-1, asset:background-1.'
      : 'Do not include image or video layers.',
    'Do not include video layers unless referencing an existing ready asset id.',
    'Text per layer max 180 characters; total visible text max 1200 characters.',
    'At most 12 scenes, 10 layers per scene, 2 video layers total.',
  ].join(' ');
}

function buildAnimationUserPrompt(request: AnimationRequest): string {
  return [
    `Prompt: ${request.prompt}`,
    `Aspect ratio: ${request.aspectRatio}`,
    `Duration target: ${request.durationSeconds} seconds (${targetDurationFrames(request.durationSeconds)} frames at 30fps)`,
    `Style preset: ${request.style}`,
    request.useGeneratedImages ? 'Include generated image placeholders where helpful.' : 'Text and shapes only.',
  ].join('\n');
}

async function generateAnimationPlan(args: {
  env: StudioAnimationEnv;
  request: AnimationRequest;
  repairIssues?: string;
  previousJson?: string;
}): Promise<AnimationProjectSpec> {
  const systemPrompt = buildAnimationSystemPrompt(args.request.useGeneratedImages);
  const userPrompt = args.repairIssues
    ? `The previous JSON failed validation with these issues:\n${args.repairIssues}\n\nReturn a corrected JSON object only. Preserve the user's prompt, aspect ratio, duration, and style.\n\nPrevious JSON:\n${args.previousJson ?? ''}`
    : buildAnimationUserPrompt(args.request);

  let raw: unknown;
  try {
    raw = await chat({
      adapter: gatewayChat(args.env as unknown as AiGatewayEnv),
      systemPrompts: [systemPrompt],
      messages: [{ role: 'user', content: userPrompt }],
      outputSchema: animationProjectOutputSchema,
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  const normalized = normalizePlanDimensions(raw as AnimationProjectSpec, args.request.aspectRatio);
  return parseAnimationProjectSpec(normalized);
}

async function computePlanHash(animation: AnimationProjectSpec): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(animation)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveOwnedAnimationAssets(args: {
  env: StudioAnimationEnv;
  userId: string;
  refs: Array<{ assetId: string; kind: 'image' | 'video' }>;
}): Promise<AnimationAssetRef[]> {
  const resolved: AnimationAssetRef[] = [];
  for (const ref of args.refs) {
    const row = await args.env.DB.prepare(
      `SELECT id, r2_key, kind FROM generated_assets WHERE id = ? AND user_id = ? AND kind = ? AND status = 'ready'`,
    ).bind(ref.assetId, args.userId, ref.kind).first<{ id: string; r2_key: string; kind: 'image' | 'video' }>();
    if (!row?.r2_key) {
      throw new Error('Asset not owned by current user');
    }
    resolved.push({ assetId: row.id, r2Key: row.r2_key, kind: row.kind });
  }
  return resolved;
}

async function generateAnimationImageAsset(args: {
  env: StudioAnimationEnv;
  userId: string;
  prompt: string;
  specJson: Record<string, unknown>;
}): Promise<{ assetId: string; r2Key: string; kind: 'image' }> {
  let result;
  try {
    result = await generateImage({
      adapter: gatewayImage(args.env as unknown as AiGatewayEnv, DEFAULT_IMAGE_MODEL),
      prompt: args.prompt,
    });
  } catch (err) {
    throw new Error(`Image generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const img = result.images[0];
  const b64 = img && 'b64Json' in img ? img.b64Json : undefined;
  if (!b64) throw new Error('Image generation returned no data');

  const bin = atob(b64);
  const decoded = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
  const bytes = decoded.byteLength;

  const usage = await getStorageUsage(args.env, args.userId);
  if (!hasRoomFor(usage, bytes)) {
    throw new Error('Storage quota exceeded');
  }

  const assetId = `a_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const r2Key = `studio/images/${assetId}.${IMAGE_EXT}`;
  await args.env.VIDEOS.put(r2Key, decoded, { httpMetadata: { contentType: IMAGE_CONTENT_TYPE } });

  const now = Date.now();
  await args.env.DB.batch([
    args.env.DB.prepare(
      `INSERT INTO generated_assets (id, user_id, kind, source, r2_key, stream_video_id, bytes, status, spec_json, error_message, project_id, created_at, updated_at) VALUES (?, ?, 'image', 'image_gen', ?, NULL, ?, 'ready', ?, NULL, NULL, ?, ?)`,
    ).bind(assetId, args.userId, r2Key, bytes, JSON.stringify(args.specJson), now, now),
    aiCostStatement(args.env.DB, {
      userId: args.userId,
      op: 'image_gen',
      route: 'dynamic/image_gen',
      model: DEFAULT_IMAGE_MODEL,
      units: 1,
      unitKind: 'images',
      estUsd: EST_USD_PER_IMAGE,
    }),
  ]);

  return { assetId, r2Key, kind: 'image' };
}

async function generateNarrationScript(args: {
  env: StudioAnimationEnv;
  request: AnimationRequest;
  animation: AnimationProjectSpec;
}): Promise<string> {
  const script = await chat({
    adapter: gatewayChat(args.env as unknown as AiGatewayEnv),
    systemPrompts: [
      'Write a concise voiceover narration script for the animation plan. Return plain text only, under 2000 characters. No markdown.',
    ],
    messages: [{
      role: 'user',
      content: `User prompt: ${args.request.prompt}\n\nAnimation title: ${args.animation.title}\nScenes: ${args.animation.scenes.map((s) => s.layers.filter((l) => l.kind === 'text').map((l) => (l as { text: string }).text).join(' ')).join(' | ')}`,
    }],
  });
  const text = typeof script === 'string' ? script : JSON.stringify(script);
  if (text.length > 2000) throw new Error('Narration script too long');
  return text;
}

async function synthesizeAnimationVoiceover(args: {
  env: StudioAnimationEnv;
  userId: string;
  jobId: string;
  text: string;
  voiceover: 'warm' | 'neutral' | 'energetic';
}): Promise<{ r2Key: string }> {
  let result: { audio: string };
  try {
    result = await generateSpeech({
      adapter: gatewayTts(args.env as unknown as AiGatewayEnv),
      text: args.text,
      voice: voiceToSpeaker(args.voiceover),
      format: 'mp3',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/content[_ ]policy|safety/i.test(msg)) {
      throw new Error('Generation failed, please try rephrasing your prompt.');
    }
    throw new Error(`TTS synthesis failed: ${msg.slice(0, 200)}`);
  }

  const bin = atob(result.audio);
  const audioBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) audioBytes[i] = bin.charCodeAt(i);
  if (audioBytes.byteLength === 0) throw new Error('TTS synthesis returned empty audio');

  const r2Key = `recorder/tts/${args.jobId}.mp3`;
  await args.env.VIDEOS.put(r2Key, audioBytes, { httpMetadata: { contentType: 'audio/mpeg' } });

  await writeAiCost(args.env.DB, {
    userId: args.userId,
    op: 'tts_gen',
    route: 'dynamic/tts',
    model: DEFAULT_TTS_MODEL,
    units: args.text.length,
    unitKind: 'characters',
    estUsd: EST_USD_TTS_BASE,
  });

  return { r2Key };
}

studioAnimationRoutes.post('/api/studio/animation', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = animationRequestSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  let animation: AnimationProjectSpec;
  try {
    animation = await generateAnimationPlan({ env: c.env, request: parsed.data });
  } catch (firstErr) {
    const issues = firstErr instanceof Error ? firstErr.message : String(firstErr);
    console.warn('[studio-animation] plan generation failed, attempting repair', { issues });
    try {
      animation = await generateAnimationPlan({
        env: c.env,
        request: parsed.data,
        repairIssues: issues,
      });
    } catch (repairErr) {
      const repairIssues = repairErr instanceof Error ? repairErr.message : String(repairErr);
      console.error('[studio-animation] plan generation failed after repair', {
        firstIssues: issues,
        repairIssues,
      });
      return c.json({
        error: 'Animation plan failed validation. Try a simpler prompt.',
        detail: repairIssues.slice(0, 600),
      }, 502);
    }
  }

  const placeholders = extractAssetPlaceholders(animation);
  if (!parsed.data.useGeneratedImages && placeholders.length > 0) {
    return c.json({ error: 'Image placeholders require useGeneratedImages' }, 400);
  }
  if (placeholders.length > MAX_GENERATED_IMAGES) {
    return c.json({ error: `At most ${MAX_GENERATED_IMAGES} generated images per animation` }, 400);
  }

  const planHash = await computePlanHash(animation);
  const assets: AnimationAssetRef[] = [];
  const placeholderMap: Record<string, string> = {};

  try {
    assets.push(...await resolveOwnedAnimationAssets({
      env: c.env,
      userId: user.id,
      refs: extractConcreteAssetRefs(animation),
    }));
  } catch {
    return c.json({ error: 'Referenced asset is not available' }, 403);
  }

  for (const placeholder of placeholders) {
    const generated = await generateAnimationImageAsset({
      env: c.env,
      userId: user.id,
      prompt: `${parsed.data.prompt}. Visual for ${placeholder}. Style: ${parsed.data.style}.`,
      specJson: {
        model: DEFAULT_IMAGE_MODEL,
        prompt: parsed.data.prompt,
        style: parsed.data.style,
        aspectRatio: parsed.data.aspectRatio,
        durationSeconds: parsed.data.durationSeconds,
        placeholder,
        planHash,
      },
    });
    placeholderMap[placeholder] = generated.assetId;
    assets.push(generated);
  }

  if (placeholders.length > 0) {
    animation = rewriteAssetPlaceholders(animation, placeholderMap);
  }

  const preJobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(preJobId, user.id, 'queued', JSON.stringify({ pending: true }), now, now).run();

  let audio: { r2Key: string } | undefined;
  if (parsed.data.voiceover !== 'none') {
    const narration = await generateNarrationScript({ env: c.env, request: parsed.data, animation });
    audio = await synthesizeAnimationVoiceover({
      env: c.env,
      userId: user.id,
      jobId: preJobId,
      text: narration,
      voiceover: parsed.data.voiceover,
    });
  }

  const imageCost = assets.length * EST_USD_PER_IMAGE;
  const ttsCost = parsed.data.voiceover !== 'none' ? EST_USD_TTS_BASE : 0;
  const estimatedCostUsd = EST_USD_ANIMATION_PLAN + imageCost + ttsCost + EST_USD_RENDER_BASE;

  await c.env.DB.batch([
    aiCostStatement(c.env.DB, {
      userId: user.id,
      op: 'animation_plan',
      route: 'dynamic/chat',
      model: DEFAULT_CHAT_MODEL,
      units: 1,
      unitKind: 'tokens',
      estUsd: EST_USD_ANIMATION_PLAN,
    }),
    aiCostStatement(c.env.DB, {
      userId: user.id,
      op: 'animation_render_estimate',
      route: 'render/container',
      model: 'spooool-animation',
      units: parsed.data.durationSeconds,
      unitKind: 'seconds',
      estUsd: EST_USD_RENDER_BASE,
    }),
  ]);

  const { jobId } = await submitRenderJob({
    userId: user.id,
    takeKeys: [],
    existingJobId: preJobId,
    compositionProps: {
      compositionId: 'spooool-animation',
      title: animation.title,
      animation,
      assets,
      audio,
      brand: { color: '#0a84ff' },
      studio: {
        source: 'ai-studio-animation',
        prompt: parsed.data.prompt,
        aspectRatio: parsed.data.aspectRatio,
        durationSeconds: parsed.data.durationSeconds,
        style: parsed.data.style,
        voiceover: parsed.data.voiceover,
        useGeneratedImages: parsed.data.useGeneratedImages,
        planHash,
        generatedAssetCount: assets.length,
      },
    },
    env: c.env,
  });

  return c.json({
    jobId,
    status: 'queued',
    estimate: {
      durationSeconds: parsed.data.durationSeconds,
      estimatedCostUsd,
    },
    generatedAssetCount: assets.length,
  }, 202);
});
