import { describe, expect, it } from 'vitest';
import {
  animationRequestSchema,
  dimensionsForAspectRatio,
  normalizeAnimationRequest,
  parseAnimationProjectSpec,
  extractAssetPlaceholders,
  extractConcreteAssetRefs,
  rewriteAssetPlaceholders,
  type AnimationProjectSpec,
} from './animation-scene-schema';

function validProject(overrides: Partial<AnimationProjectSpec> = {}): AnimationProjectSpec {
  return {
    version: 1,
    title: 'Launch',
    fps: 30,
    width: 1920,
    height: 1080,
    durationFrames: 450,
    background: { kind: 'solid', color: '#0a84ff' },
    scenes: [
      {
        id: 'scene-1',
        startFrame: 0,
        durationFrames: 450,
        layout: 'title',
        layers: [
          {
            kind: 'text',
            id: 'headline',
            startFrame: 0,
            durationFrames: 450,
            x: 160,
            y: 240,
            width: 1600,
            height: 240,
            text: 'A faster way to explain ideas',
            fontSize: 88,
            fontWeight: 700,
            align: 'center',
            color: '#ffffff',
            motion: [{ property: 'opacity', from: 0, to: 1, startFrame: 0, durationFrames: 30, easing: 'easeOut' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('animation request parsing', () => {
  it('applies approved defaults', () => {
    const parsed = normalizeAnimationRequest({ prompt: 'make a clean product launch animation' });
    expect(parsed).toEqual({
      prompt: 'make a clean product launch animation',
      aspectRatio: '16:9',
      durationSeconds: 30,
      style: 'clean',
      voiceover: 'none',
      useGeneratedImages: false,
    });
  });

  it('rejects empty and overlong prompts', () => {
    expect(animationRequestSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(animationRequestSchema.safeParse({ prompt: 'a'.repeat(2049) }).success).toBe(false);
  });

  it('maps aspect ratios to supported render dimensions', () => {
    expect(dimensionsForAspectRatio('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsForAspectRatio('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsForAspectRatio('1:1')).toEqual({ width: 1080, height: 1080 });
  });
});

describe('AnimationProjectSpec validation', () => {
  it('accepts a valid project', () => {
    expect(parseAnimationProjectSpec(validProject()).durationFrames).toBe(450);
  });

  it('rejects a duration that does not match scene coverage', () => {
    expect(() => parseAnimationProjectSpec(validProject({ durationFrames: 451 }))).toThrow(/duration/i);
  });

  it('rejects overlapping scenes', () => {
    const project = validProject({
      durationFrames: 600,
      scenes: [
        validProject().scenes[0],
        { ...validProject().scenes[0], id: 'scene-2', startFrame: 300, durationFrames: 300 },
      ],
    });
    expect(() => parseAnimationProjectSpec(project)).toThrow(/overlap|coverage/i);
  });

  it('rejects named colors for deterministic rendering', () => {
    const project = validProject({
      background: { kind: 'solid', color: 'blue' },
    });
    expect(() => parseAnimationProjectSpec(project)).toThrow(/color/i);
  });

  it('rejects layers that extend past their scene', () => {
    const scene = validProject().scenes[0];
    const project = validProject({
      scenes: [{ ...scene, layers: [{ ...scene.layers[0], startFrame: 400, durationFrames: 100 }] }],
    });
    expect(() => parseAnimationProjectSpec(project)).toThrow(/layer/i);
  });

  it('rejects more than twelve scenes', () => {
    const scenes = Array.from({ length: 13 }, (_, i) => ({
      ...validProject().scenes[0],
      id: `scene-${i}`,
      startFrame: i * 150,
      durationFrames: 150,
    }));
    expect(() => parseAnimationProjectSpec(validProject({ durationFrames: 1950, scenes }))).toThrow(/scenes/i);
  });
});

describe('animation asset placeholders', () => {
  it('extracts unique image placeholders in layer order', () => {
    const project = validProject({
      scenes: [{
        ...validProject().scenes[0],
        layers: [
          { ...validProject().scenes[0].layers[0], id: 'text' },
          {
            kind: 'image',
            id: 'hero',
            startFrame: 0,
            durationFrames: 450,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            assetId: 'asset:hero-1',
            fit: 'cover',
          },
        ],
      }],
    });
    expect(extractAssetPlaceholders(project)).toEqual(['asset:hero-1']);
  });

  it('rewrites placeholders to concrete generated asset ids', () => {
    const project = validProject({
      scenes: [{
        ...validProject().scenes[0],
        layers: [{
          kind: 'image',
          id: 'hero',
          startFrame: 0,
          durationFrames: 450,
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          assetId: 'asset:hero-1',
          fit: 'cover',
        }],
      }],
    });
    const rewritten = rewriteAssetPlaceholders(project, { 'asset:hero-1': 'a_1234567890abcdef' });
    expect(rewritten.scenes[0].layers[0]).toMatchObject({ kind: 'image', assetId: 'a_1234567890abcdef' });
  });

  it('extracts concrete asset refs without placeholders', () => {
    const project = validProject({
      scenes: [{
        ...validProject().scenes[0],
        layers: [{
          kind: 'image',
          id: 'hero',
          startFrame: 0,
          durationFrames: 450,
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          assetId: 'a_ready1234567890',
          fit: 'cover',
        }],
      }],
    });
    expect(extractConcreteAssetRefs(project)).toEqual([{ assetId: 'a_ready1234567890', kind: 'image' }]);
  });
});
