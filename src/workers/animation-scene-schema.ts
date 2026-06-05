import { z } from 'zod';

export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);
export const durationSecondsSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(45),
  z.literal(60),
  z.literal(90),
]);
export const stylePresetSchema = z.enum(['clean', 'playful', 'cinematic', 'technical', 'social']);
export const voiceoverSchema = z.enum(['none', 'warm', 'neutral', 'energetic']);

export const animationRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(2048),
  aspectRatio: aspectRatioSchema.default('16:9'),
  durationSeconds: durationSecondsSchema.default(30),
  style: stylePresetSchema.default('clean'),
  voiceover: voiceoverSchema.default('none'),
  useGeneratedImages: z.boolean().default(false),
});

export type AnimationRequest = z.infer<typeof animationRequestSchema>;
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export function dimensionsForAspectRatio(aspectRatio: AspectRatio): { width: 1920 | 1080; height: 1080 | 1920 } {
  if (aspectRatio === '9:16') return { width: 1080, height: 1920 };
  if (aspectRatio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

export function normalizeAnimationRequest(input: unknown): AnimationRequest {
  return animationRequestSchema.parse(input);
}

const colorSchema = z.string().refine(
  (value) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
    || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(value),
  { message: 'Color must be hex (#rgb or #rrggbb) or rgb()/rgba()' },
);

export const frameDrivenMotionSchema = z.object({
  property: z.enum(['x', 'y', 'scale', 'rotate', 'opacity']),
  from: z.number().finite(),
  to: z.number().finite(),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  easing: z.enum(['linear', 'easeOut', 'easeInOut', 'spring']),
});

const backgroundSchema = z.object({
  kind: z.enum(['solid', 'gradient']),
  color: colorSchema.optional(),
  from: colorSchema.optional(),
  to: colorSchema.optional(),
  direction: z.enum(['vertical', 'horizontal', 'diagonal']).optional(),
});

const baseLayerSchema = z.object({
  id: z.string().min(1),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  opacity: z.number().min(0).max(1).optional(),
  zIndex: z.number().int().optional(),
  motion: z.array(frameDrivenMotionSchema).max(8).optional(),
});

const textLayerSchema = baseLayerSchema.extend({
  kind: z.literal('text'),
  text: z.string().max(180),
  fontSize: z.number().finite().positive(),
  fontWeight: z.union([
    z.literal(400),
    z.literal(500),
    z.literal(600),
    z.literal(700),
    z.literal(800),
  ]),
  align: z.enum(['left', 'center', 'right']),
  color: colorSchema,
});

const shapeLayerSchema = baseLayerSchema.extend({
  kind: z.literal('shape'),
  shape: z.enum(['rect', 'roundRect', 'circle', 'line']),
  fill: colorSchema.optional(),
  stroke: colorSchema.optional(),
  strokeWidth: z.number().finite().nonnegative().optional(),
  radius: z.number().finite().nonnegative().optional(),
});

const imageLayerSchema = baseLayerSchema.extend({
  kind: z.literal('image'),
  assetId: z.string().min(1),
  fit: z.enum(['cover', 'contain']),
});

const videoLayerSchema = baseLayerSchema.extend({
  kind: z.literal('video'),
  assetId: z.string().min(1),
  fit: z.enum(['cover', 'contain']),
  trimBeforeFrames: z.number().int().min(0).optional(),
  volume: z.number().min(0).max(1).optional(),
});

export const animationLayerSpecSchema = z.discriminatedUnion('kind', [
  textLayerSchema,
  shapeLayerSchema,
  imageLayerSchema,
  videoLayerSchema,
]);

export const animationSceneSpecSchema = z.object({
  id: z.string().min(1),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  layout: z.enum(['title', 'split', 'centerpiece', 'captioned-asset', 'outro']),
  background: backgroundSchema.optional(),
  layers: z.array(animationLayerSpecSchema).max(10),
  transitionOut: z.object({
    kind: z.enum(['cut', 'fade', 'wipe']),
    durationFrames: z.number().int().min(0).max(60),
  }).optional(),
});

export const animationProjectSpecSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(120),
  fps: z.literal(30),
  width: z.union([z.literal(1920), z.literal(1080)]),
  height: z.union([z.literal(1080), z.literal(1920)]),
  durationFrames: z.number().int().min(150).max(2700),
  background: backgroundSchema,
  scenes: z.array(animationSceneSpecSchema).min(1).max(12),
});

export type AnimationProjectSpec = z.infer<typeof animationProjectSpecSchema>;
export type AnimationSceneSpec = z.infer<typeof animationSceneSpecSchema>;
export type AnimationLayerSpec = z.infer<typeof animationLayerSpecSchema>;
export type FrameDrivenMotionSpec = z.infer<typeof frameDrivenMotionSchema>;
export type AnimationAssetRef = {
  assetId: string;
  r2Key: string;
  kind: 'image' | 'video' | 'audio';
};

const MAX_VIDEO_LAYERS = 2;
const MAX_TOTAL_TEXT_CHARS = 1200;

function sceneEndFrame(scene: AnimationSceneSpec): number {
  return scene.startFrame + scene.durationFrames;
}

function validateProjectCrossFields(project: AnimationProjectSpec, ctx: z.RefinementCtx): void {
  const scenes = [...project.scenes].sort((a, b) => a.startFrame - b.startFrame);
  if (scenes[0]?.startFrame !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'First scene must start at frame 0', path: ['scenes'] });
  }

  let expectedStart = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    if (scene.startFrame !== expectedStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Scene ${scene.id} must start at frame ${expectedStart} (coverage gap or overlap)`,
        path: ['scenes', i, 'startFrame'],
      });
    }
    expectedStart = sceneEndFrame(scene);

    if (scene.transitionOut && scene.transitionOut.durationFrames > scene.durationFrames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transitionOut.durationFrames exceeds scene duration',
        path: ['scenes', i, 'transitionOut', 'durationFrames'],
      });
    }

    for (let j = 0; j < scene.layers.length; j++) {
      const layer = scene.layers[j];
      if (layer.startFrame + layer.durationFrames > scene.durationFrames) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Layer ${layer.id} extends past scene ${scene.id}`,
          path: ['scenes', i, 'layers', j],
        });
      }
      for (let k = 0; k < (layer.motion?.length ?? 0); k++) {
        const motion = layer.motion![k];
        if (motion.startFrame + motion.durationFrames > layer.durationFrames) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Motion on layer ${layer.id} extends past layer duration`,
            path: ['scenes', i, 'layers', j, 'motion', k],
          });
        }
      }
    }
  }

  if (expectedStart !== project.durationFrames) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `durationFrames (${project.durationFrames}) must equal final scene end (${expectedStart})`,
      path: ['durationFrames'],
    });
  }

  let videoLayerCount = 0;
  let totalTextChars = 0;
  for (const scene of project.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind === 'video') videoLayerCount++;
      if (layer.kind === 'text') totalTextChars += layer.text.length;
    }
  }
  if (videoLayerCount > MAX_VIDEO_LAYERS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `At most ${MAX_VIDEO_LAYERS} video layers allowed`,
      path: ['scenes'],
    });
  }
  if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Total text exceeds ${MAX_TOTAL_TEXT_CHARS} characters`,
      path: ['scenes'],
    });
  }
}

const validatedAnimationProjectSpecSchema = animationProjectSpecSchema.superRefine(validateProjectCrossFields);

export function parseAnimationProjectSpec(input: unknown): AnimationProjectSpec {
  return validatedAnimationProjectSpecSchema.parse(input);
}

export function extractAssetPlaceholders(project: AnimationProjectSpec): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const scene of project.scenes) {
    for (const layer of scene.layers) {
      if ((layer.kind === 'image' || layer.kind === 'video') && layer.assetId.startsWith('asset:') && !seen.has(layer.assetId)) {
        seen.add(layer.assetId);
        ordered.push(layer.assetId);
      }
    }
  }
  return ordered;
}

export function extractConcreteAssetRefs(project: AnimationProjectSpec): Array<{ assetId: string; kind: 'image' | 'video' }> {
  const seen = new Set<string>();
  const ordered: Array<{ assetId: string; kind: 'image' | 'video' }> = [];
  for (const scene of project.scenes) {
    for (const layer of scene.layers) {
      if ((layer.kind === 'image' || layer.kind === 'video') && !layer.assetId.startsWith('asset:') && !seen.has(layer.assetId)) {
        seen.add(layer.assetId);
        ordered.push({ assetId: layer.assetId, kind: layer.kind });
      }
    }
  }
  return ordered;
}

export function rewriteAssetPlaceholders(project: AnimationProjectSpec, map: Record<string, string>): AnimationProjectSpec {
  const copy = structuredClone(project) as AnimationProjectSpec;
  for (const scene of copy.scenes) {
    for (const layer of scene.layers) {
      if ((layer.kind === 'image' || layer.kind === 'video') && layer.assetId.startsWith('asset:')) {
        const mapped = map[layer.assetId];
        if (!mapped) throw new Error(`Missing generated asset for ${layer.assetId}`);
        layer.assetId = mapped;
      }
    }
  }
  return parseAnimationProjectSpec(copy);
}

export { animationProjectSpecSchema as animationProjectOutputSchema };
