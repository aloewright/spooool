import { z } from 'zod';

const colorSchema = z.string().refine(
  (value) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
    || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(value),
  { message: 'Color must be hex or rgb()/rgba()' },
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

const animationLayerSpecSchema = z.discriminatedUnion('kind', [
  textLayerSchema,
  shapeLayerSchema,
  imageLayerSchema,
  videoLayerSchema,
]);

const animationSceneSpecSchema = z.object({
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
  r2Path?: string;
  kind: 'image' | 'video' | 'audio';
};

export type AnimationCompositionProps = {
  compositionId?: string;
  animation: AnimationProjectSpec;
  assets?: AnimationAssetRef[];
  audio?: { r2Key?: string; r2Path?: string };
  brand?: { color?: string };
};

export function resolveAnimationProps(input: unknown): AnimationCompositionProps {
  const raw = input as Record<string, unknown>;
  let animation: AnimationProjectSpec;
  try {
    animation = animationProjectSpecSchema.parse(raw.animation);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid animation props: ${detail}`);
  }
  const assets = Array.isArray(raw.assets) ? raw.assets as AnimationAssetRef[] : undefined;
  const audio = raw.audio as AnimationCompositionProps['audio'] | undefined;
  const brand = raw.brand as AnimationCompositionProps['brand'] | undefined;
  return {
    compositionId: typeof raw.compositionId === 'string' ? raw.compositionId : undefined,
    animation,
    assets,
    audio,
    brand,
  };
}

export function assetPathById(assets: AnimationAssetRef[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!assets) return map;
  for (const asset of assets) {
    if (asset.assetId && asset.r2Path) map.set(asset.assetId, asset.r2Path);
  }
  return map;
}
