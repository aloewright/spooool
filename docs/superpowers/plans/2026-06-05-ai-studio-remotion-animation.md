# AI Studio Remotion Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not build E10 timeline editing in this slice.

**Goal:** Let verified AI Studio users submit a prompt and receive a standalone prompt-generated MP4 rendered through `compositionId: "spooool-animation"` using trusted Remotion components, existing render jobs, R2, encoding, Stream handoff, and normal `videos` paths.

**Architecture:** Add a focused Studio animation route that validates user input, asks AI Gateway for typed JSON only, validates and normalizes an `AnimationProjectSpec`, optionally generates capped image assets and voiceover, records cost/provenance metadata, and dispatches `submitRenderJob` with `takeKeys: []`. The render container registers a new deterministic Remotion composition, stages referenced R2 assets into `remotion/public/{jobId}/`, rewrites asset refs to `staticFile()` paths, and keeps the existing callback contract unchanged.

**Tech Stack:** Cloudflare Workers, Hono, D1, R2, Queues, AI Gateway via `@tanstack/ai`, Zod, React, Remotion, Vitest, happy-dom, oxlint, TypeScript.

---

## Patterns & Conventions Found

- `src/workers/studio.ts:48-155` owns AI Studio routes and already gates `/api/studio/chat`, `/api/studio/image`, and `/api/studio/video` with authenticated verified users, `STUDIO_GEN_BUCKET`, Zod body validation, R2 writes, `generated_assets`, and `ai_costs`.
- `src/workers/ai-gateway.ts:260-271` is the single gateway-routed AI transport. New planning and TTS code must use `gatewayChat()` and `gatewayTts()` rather than direct provider SDKs or provider URLs.
- `src/workers/create-tools.ts:155-184` shows the existing structured scene-plan pattern: `chat({ adapter: gatewayChat(...), outputSchema })`, catch schema failures, normalize durations, and return trusted typed data.
- `src/workers/create-tools.ts:261-319` already synthesizes TTS through `generateSpeech({ adapter: gatewayTts(...) })`, writes MP3 bytes to `recorder/tts/{jobId}.mp3`, and masks content-policy failures.
- `src/workers/render.ts:50-88` is the only render dispatch API. It inserts or updates `render_jobs.composition_spec`, then calls the per-user render container instance.
- `src/workers/render.ts:140-162` exposes the existing polling route used by the UI: `GET /api/render/jobs/:id` returns `status`, `progress`, `videoId`, and `error`.
- `src/workers/render.ts:165-212` completes a render by inserting a `videos` row and enqueuing `VIDEO_ENCODING`. This plan extends the insert to mark AI-generated animation outputs.
- `container/render/src/render.ts:58-111` bundles once, stages recorded takes and `audio.r2Key`, selects `props.compositionId` with fallback to `spooool-video`, and calls `renderMedia`.
- `container/render/remotion/Root.tsx:34-50` registers `spooool-explainer` beside `spooool-video`; `spooool-animation` should follow this same registration style with dynamic metadata.
- `container/render/remotion/SpoooolExplainer.tsx:1-66` is a simple trusted composition driven by props. The new animation composition should be richer but keep the same trusted-code boundary: the model emits JSON, not React or CSS.
- `src/db/migrations/0022_studio_assets.sql:41-82` already provides `generated_assets`, `ai_costs`, `videos.ai_generated`, and `videos.source_video_id`; no new schema migration is needed for the first slice.
- `src/frontend/studio/index.tsx:1-17`, `src/frontend/studio/ImagePanel.tsx:1-104`, and `src/frontend/studio/lib/studio-client.ts:1-62` show the current AI Studio UI structure and same-origin client helper style.
- `package.json:14-22` defines root verification commands: `npm test`, `npm run lint`, `npm run type-check`, and `npm run build`. `container/render/package.json:7-9` defines container verification commands: `npm run build` and `npm test`.

## File Structure

Create:

- `src/workers/animation-scene-schema.ts` - Worker-side request parsing, aspect ratio dimensions, Zod schemas, scene/layer validation, asset placeholder extraction, asset ID rewrite, and user-safe validation errors.
- `src/workers/animation-scene-schema.test.ts` - Unit tests for request defaults, dimensions, duration coverage, layer bounds, color validation, caps, placeholders, and asset rewrite.
- `src/workers/studio-animation.ts` - Hono route for `POST /api/studio/animation`, AI plan generation, one re-prompt on invalid JSON, optional image generation, optional TTS, cost writes, render dispatch, and response shaping.
- `src/workers/studio-animation.test.ts` - Route tests for auth, verification, request validation, rate limiting, successful dispatch, invalid-model retry, model failure, asset generation, TTS, cost rows, and ownership checks.
- `src/frontend/studio/AnimationPanel.tsx` - Studio panel for prompt-generated animated videos, stage progress, estimates, generated asset count, render polling, errors, and watch link.
- `src/frontend/studio/AnimationPanel.dom.test.tsx` - DOM tests for the panel form, submit payload, queued state, polling to `videoId`, validation, and error display.
- `container/render/remotion/animation/animation-spec.ts` - Container-local validation and helper types for defensive prop validation before rendering.
- `container/render/remotion/animation/motion.ts` - Frame-driven motion helpers using `useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, and deterministic math only.
- `container/render/remotion/animation/AnimationLayer.tsx` - Trusted renderer for text, shape, image, and video layers.
- `container/render/remotion/animation/AnimationScene.tsx` - Trusted renderer for one scene and its transition-out effect.
- `container/render/remotion/SpoooolAnimation.tsx` - Top-level Remotion composition, optional audio, background, scene sequencing, metadata helpers, and default props.
- `container/render/remotion/SpoooolAnimation.test.tsx` - Unit tests for duration/dimensions, default props, validation failure, and layer helper behavior.
- `container/render/remotion/SpoooolAnimation.static.test.ts` - Static guard that fails on forbidden runtime animation patterns in the new composition files.
- `scripts/check-remotion-animation.mjs` - CI-friendly static check for forbidden Remotion animation patterns in `container/render/remotion/SpoooolAnimation.tsx` and `container/render/remotion/animation/**/*.tsx`.
- `scripts/check-remotion-animation.test.mjs` - Tests for the static check script.

Modify:

- `src/workers/index.ts` - Import and mount `studioAnimationRoutes`; add `StudioAnimationEnv` to `EnvBindings`.
- `src/workers/render.ts` - Allow `takeKeys: []` on `POST /api/render/jobs`; set `videos.ai_generated = 1` for completed jobs whose `compositionProps.compositionId` is `spooool-animation`.
- `src/workers/render.test.ts` - Add coverage for empty `takeKeys` and AI-generated video insertion.
- `src/frontend/studio/index.tsx` - Add an **Animated video** section above image generation.
- `src/frontend/studio/lib/studio-client.ts` - Add `postAnimation()` and `getRenderJob()` helpers plus response types.
- `src/frontend/pages/Studio.tsx` - Update page copy so AI Studio names animated videos in addition to chat and thumbnails.
- `src/frontend/studio/AIStudio.dom.test.tsx` - Update broad StudioRoot smoke assertions to account for the new panel.
- `container/render/src/render.ts` - Stage `compositionProps.assets[]` R2 refs into public files and inject `r2Path` for composition use.
- `container/render/src/render.test.ts` - Add staging tests for animation image/video/audio assets and legacy composition fallback.
- `container/render/remotion/Root.tsx` - Register `spooool-animation` with dynamic duration and dimensions.
- `package.json` - Add `"lint:remotion-animation": "node scripts/check-remotion-animation.mjs"` and include it in `"lint"`.
- `scripts/check-no-direct-providers.mjs` only if the new route introduces false positives; otherwise leave it unchanged.

Out of scope:

- Uploaded-video timeline editing, clip handles, trimming, split tools, browser scrubber, project timeline persistence, and `/edit/:videoId` import flows.
- Server-side Stream concatenation.
- Model-generated React, TSX, CSS, CSS transitions, CSS animations, Tailwind animation classes, timers, random values, or browser event handlers inside the Remotion composition.
- Generated video b-roll as a default model output. The first route should support ready video assets defensively in the renderer, but the planning prompt should omit video layers until the `AI_GEN` queue is production-stable for this route.

## Data Flow

1. `AnimationPanel` submits `{ prompt, aspectRatio, durationSeconds, style, voiceover, useGeneratedImages }` to `POST /api/studio/animation`.
2. `studioAnimationRoutes` verifies user/session state, rate-limits with `STUDIO_GEN_BUCKET`, validates the body, and computes dimensions from aspect ratio.
3. `generateAnimationPlan()` calls `chat({ adapter: gatewayChat(...), outputSchema: animationProjectSchema })` with a JSON-only system prompt. If the result fails local validation, it makes exactly one repair request with validation issues and the original JSON.
4. `parseAnimationProjectSpec()` enforces scene coverage, caps, color formats, layer bounds, and deterministic motion constraints.
5. If `useGeneratedImages` is true, asset placeholders like `asset:hero-1` are turned into capped image prompts and stored through the same R2 + `generated_assets` pattern as `/api/studio/image`. If the option is false, the schema rejects image layers that still contain placeholders.
6. If `voiceover !== "none"`, a short narration script is generated from the validated plan, synthesized through `gatewayTts()`, written to `recorder/tts/{jobId}.mp3`, and passed as `compositionProps.audio.r2Key`.
7. The route writes `ai_costs` rows for `animation_plan`, optional `image_gen`, optional `tts_gen`, and `animation_render_estimate`.
8. The route dispatches `submitRenderJob({ takeKeys: [], compositionProps: { compositionId: "spooool-animation", title, animation, assets, audio, brand, studio: metadata } })`.
9. `container/render/src/render.ts` stages audio and `assets[]` into `remotion/public/{jobId}/`, injects `r2Path`, selects `spooool-animation`, renders MP4, and posts existing progress/complete callbacks.
10. `/api/render/jobs/:id/complete` marks the render job complete, creates a `videos` row with `ai_generated = 1`, enqueues `VIDEO_ENCODING`, and the UI polling eventually links to `/watch/:videoId`.

## Implementation Tasks

### Task 1: Worker Animation Schema

**Files:**
- Create: `src/workers/animation-scene-schema.ts`
- Create: `src/workers/animation-scene-schema.test.ts`

- [ ] **Step 1: Write failing request defaults and dimensions tests**

Add tests that encode the approved request contract and dimension presets:

```ts
import { describe, expect, it } from 'vitest';
import { animationRequestSchema, dimensionsForAspectRatio, normalizeAnimationRequest } from './animation-scene-schema';

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
```

- [ ] **Step 2: Run the schema tests and confirm they fail**

Run: `npm test -- src/workers/animation-scene-schema.test.ts`

Expected: FAIL because `src/workers/animation-scene-schema.ts` does not exist.

- [ ] **Step 3: Implement request schema and dimension helpers**

Create `src/workers/animation-scene-schema.ts` with these exported names:

```ts
import { z } from 'zod';

export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);
export const durationSecondsSchema = z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
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
```

- [ ] **Step 4: Verify request schema tests pass**

Run: `npm test -- src/workers/animation-scene-schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing project schema validation tests**

Extend `src/workers/animation-scene-schema.test.ts` with tests for duration coverage, scene ordering, layer bounds, colors, text caps, scene caps, and motion fields:

```ts
import {
  parseAnimationProjectSpec,
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
```

- [ ] **Step 6: Run validation tests and confirm they fail**

Run: `npm test -- src/workers/animation-scene-schema.test.ts`

Expected: FAIL because `parseAnimationProjectSpec` and related types are not implemented.

- [ ] **Step 7: Implement `AnimationProjectSpec` Zod schemas**

Add the schema from the approved spec with these exact exported names:

```ts
export type AnimationProjectSpec = z.infer<typeof animationProjectSpecSchema>;
export type AnimationSceneSpec = z.infer<typeof animationSceneSpecSchema>;
export type AnimationLayerSpec = z.infer<typeof animationLayerSpecSchema>;
export type AnimationAssetRef = {
  assetId: string;
  r2Key: string;
  kind: 'image' | 'video' | 'audio';
};

export const frameDrivenMotionSchema = z.object({
  property: z.enum(['x', 'y', 'scale', 'rotate', 'opacity']),
  from: z.number().finite(),
  to: z.number().finite(),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  easing: z.enum(['linear', 'easeOut', 'easeInOut', 'spring']),
});
```

Implement the layer union with `kind: 'text' | 'shape' | 'image' | 'video'`, max 10 layers per scene, max 2 video layers per project, max 12 scenes, 150-2700 total frames, fps fixed at 30, and dimensions fixed to `1920x1080`, `1080x1920`, or `1080x1080`.

- [ ] **Step 8: Implement cross-field validation**

Implement `parseAnimationProjectSpec(input: unknown): AnimationProjectSpec` using `animationProjectSpecSchema.superRefine(...)` or a post-parse validator. Enforce:

- Scenes sorted by `startFrame`.
- First scene starts at frame `0`.
- Each scene starts exactly at the previous scene end.
- `durationFrames` equals the final scene end frame.
- Layer `startFrame + durationFrames` is within its scene.
- Motion `startFrame + durationFrames` is within its layer.
- Text layer text is at most 180 characters.
- Total text across all layers is at most 1,200 characters.
- Colors match `#rgb`, `#rrggbb`, `rgb(...)`, or `rgba(...)`; reject named CSS colors.
- `transitionOut.durationFrames` is at most the scene duration and at most 60 frames.

- [ ] **Step 9: Verify validation tests pass**

Run: `npm test -- src/workers/animation-scene-schema.test.ts`

Expected: PASS.

- [ ] **Step 10: Write failing asset placeholder tests**

Add tests for placeholder extraction and rewrite:

```ts
import { extractAssetPlaceholders, rewriteAssetPlaceholders } from './animation-scene-schema';

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
});
```

- [ ] **Step 11: Implement placeholder helpers**

Implement:

```ts
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
```

- [ ] **Step 12: Verify all schema tests pass**

Run: `npm test -- src/workers/animation-scene-schema.test.ts`

Expected: PASS.

### Task 2: Remotion Composition Foundation

**Files:**
- Create: `container/render/remotion/animation/animation-spec.ts`
- Create: `container/render/remotion/animation/motion.ts`
- Create: `container/render/remotion/animation/AnimationLayer.tsx`
- Create: `container/render/remotion/animation/AnimationScene.tsx`
- Create: `container/render/remotion/SpoooolAnimation.tsx`
- Create: `container/render/remotion/SpoooolAnimation.test.tsx`
- Modify: `container/render/remotion/Root.tsx`

- [ ] **Step 1: Write failing component helper tests**

Create `container/render/remotion/SpoooolAnimation.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANIMATION_PROJECT,
  SpoooolAnimation,
  calculateAnimationMetadata,
  calculateAnimationDuration,
} from './SpoooolAnimation';
import { resolveAnimationProps } from './animation/animation-spec';

describe('SpoooolAnimation', () => {
  it('exports a React component', () => {
    expect(typeof SpoooolAnimation).toBe('function');
  });

  it('calculates duration from validated props', () => {
    expect(calculateAnimationDuration(DEFAULT_ANIMATION_PROJECT)).toBe(DEFAULT_ANIMATION_PROJECT.durationFrames);
  });

  it('calculates dimensions from validated props', () => {
    expect(calculateAnimationMetadata({ animation: DEFAULT_ANIMATION_PROJECT })).toMatchObject({
      width: 1920,
      height: 1080,
      durationInFrames: DEFAULT_ANIMATION_PROJECT.durationFrames,
    });
  });

  it('rejects malformed container props clearly', () => {
    expect(() => resolveAnimationProps({ animation: { version: 1, scenes: [] } })).toThrow(/animation/i);
  });
});
```

- [ ] **Step 2: Run component tests and confirm they fail**

Run: `cd container/render && npm test -- remotion/SpoooolAnimation.test.tsx`

Expected: FAIL because the component files do not exist.

- [ ] **Step 3: Implement container-local prop validation**

Create `container/render/remotion/animation/animation-spec.ts` with container-local schemas matching `src/workers/animation-scene-schema.ts`. Export:

```ts
export type AnimationProjectSpec = z.infer<typeof animationProjectSpecSchema>;
export type AnimationAssetRef = { assetId: string; r2Key: string; r2Path?: string; kind: 'image' | 'video' | 'audio' };
export type AnimationCompositionProps = {
  compositionId?: string;
  animation: AnimationProjectSpec;
  assets?: AnimationAssetRef[];
  audio?: { r2Key?: string; r2Path?: string };
  brand?: { color?: string };
};
export function resolveAnimationProps(input: unknown): AnimationCompositionProps;
export function assetPathById(assets: AnimationAssetRef[] | undefined): Map<string, string>;
```

Keep this file free of React imports so it can be tested and reused by render helpers.

- [ ] **Step 4: Implement frame-driven motion helpers**

Create `container/render/remotion/animation/motion.ts` with helpers that only use frame-driven Remotion primitives:

```ts
import { Easing, interpolate, spring } from 'remotion';
import type { FrameDrivenMotionSpec } from './animation-spec';

export function motionValue(spec: FrameDrivenMotionSpec, frame: number, fps: number): number {
  const relative = frame - spec.startFrame;
  if (spec.easing === 'spring') {
    return spring({ frame: relative, fps, from: spec.from, to: spec.to, durationInFrames: spec.durationFrames });
  }
  const easing = spec.easing === 'easeOut'
    ? Easing.out(Easing.cubic)
    : spec.easing === 'easeInOut'
      ? Easing.inOut(Easing.cubic)
      : Easing.linear;
  return interpolate(frame, [spec.startFrame, spec.startFrame + spec.durationFrames], [spec.from, spec.to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}
```

Every visual motion in `spooool-animation` must call this helper or equivalent frame math from `useCurrentFrame()`, `interpolate()`, `spring()`, and `Sequence`.

- [ ] **Step 5: Implement layer rendering with Remotion media components**

Create `AnimationLayer.tsx` with:

- `TextAnimationLayer` rendering text as text content, never HTML.
- `ShapeAnimationLayer` rendering `rect`, `roundRect`, `circle`, and `line` with inline styles.
- `ImageAnimationLayer` rendering `<Img src={staticFile(path)} />`.
- `VideoAnimationLayer` rendering `<OffthreadVideo src={staticFile(path)} startFrom={trimBeforeFrames ?? 0} volume={volume ?? 0} />`.
- A shared `styleForLayer()` that composes `left`, `top`, `width`, `height`, `opacity`, `transform`, and `zIndex` from frame-driven motion values.

Do not use `transition`, `animation`, `@keyframes`, `animate-*`, `transition-*`, `duration-*`, `ease-*`, `setTimeout`, `setInterval`, `Date.now()`, or `Math.random()` in any composition file.

- [ ] **Step 6: Implement scene rendering**

Create `AnimationScene.tsx` that renders:

- One `<AbsoluteFill>` scene background.
- One `<Sequence from={layer.startFrame} durationInFrames={layer.durationFrames} layout="none">` per layer.
- Transition-out effects as frame-driven opacity or clip-path style values computed from current frame. For `wipe`, use a deterministic inline `clipPath` value driven by `interpolate()`; do not use CSS animation.

- [ ] **Step 7: Implement top-level composition**

Create `SpoooolAnimation.tsx` with:

- `DEFAULT_ANIMATION_PROJECT`: a valid one-frame-safe project with one 150-frame scene.
- `calculateAnimationDuration(project)` returning `Math.max(1, project.durationFrames)`.
- `calculateAnimationMetadata(props)` returning `{ durationInFrames, width, height, props: resolvedProps }`.
- `SpoooolAnimation` rendering `<Audio src={staticFile(audio.r2Path)} />` when present and one `<Sequence>` per scene.

- [ ] **Step 8: Register `spooool-animation`**

Modify `container/render/remotion/Root.tsx` to import `SpoooolAnimation`, `DEFAULT_ANIMATION_PROJECT`, and `calculateAnimationMetadata`, then add:

```tsx
<Composition
  id="spooool-animation"
  component={SpoooolAnimation}
  width={1920}
  height={1080}
  fps={30}
  durationInFrames={DEFAULT_ANIMATION_PROJECT.durationFrames}
  defaultProps={{
    compositionId: 'spooool-animation',
    animation: DEFAULT_ANIMATION_PROJECT,
    assets: [],
    brand: { color: '#0a84ff' },
  }}
  calculateMetadata={({ props }) => calculateAnimationMetadata(props)}
/>
```

- [ ] **Step 9: Verify component tests pass**

Run: `cd container/render && npm test -- remotion/SpoooolAnimation.test.tsx`

Expected: PASS.

### Task 3: Remotion Animation Static Guard

**Files:**
- Create: `scripts/check-remotion-animation.mjs`
- Create: `scripts/check-remotion-animation.test.mjs`
- Create: `container/render/remotion/SpoooolAnimation.static.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing script tests**

Create `scripts/check-remotion-animation.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { containsForbiddenRemotionAnimationPattern } from './check-remotion-animation.mjs';

describe('check-remotion-animation', () => {
  it('flags CSS transitions and animation classes', () => {
    expect(containsForbiddenRemotionAnimationPattern('style={{ transition: "opacity 1s" }}')).toBe(true);
    expect(containsForbiddenRemotionAnimationPattern('className="animate-pulse"')).toBe(true);
    expect(containsForbiddenRemotionAnimationPattern('@keyframes fade')).toBe(true);
  });

  it('allows frame-driven Remotion primitives', () => {
    expect(containsForbiddenRemotionAnimationPattern('const frame = useCurrentFrame(); interpolate(frame, [0, 30], [0, 1]);')).toBe(false);
  });
});
```

- [ ] **Step 2: Run script tests and confirm they fail**

Run: `npm test -- scripts/check-remotion-animation.test.mjs`

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the static check script**

Create `scripts/check-remotion-animation.mjs` with:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  /\btransition\s*:/,
  /\banimation\s*:/,
  /@keyframes\b/,
  /className=["'`][^"'`]*\banimate-/,
  /className=["'`][^"'`]*\btransition-/,
  /className=["'`][^"'`]*\bduration-/,
  /className=["'`][^"'`]*\bease-/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
];

export function containsForbiddenRemotionAnimationPattern(source) {
  return FORBIDDEN.some((pattern) => pattern.test(source));
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx|ts)$/.test(entry.name) ? [full] : [];
  });
}

export function checkFiles(root = process.cwd()) {
  const targets = [
    path.join(root, 'container/render/remotion/SpoooolAnimation.tsx'),
    ...walk(path.join(root, 'container/render/remotion/animation')),
  ].filter((file) => fs.existsSync(file));
  const failures = targets.filter((file) => containsForbiddenRemotionAnimationPattern(fs.readFileSync(file, 'utf8')));
  return failures;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const failures = checkFiles();
  if (failures.length > 0) {
    console.error(`Forbidden Remotion animation patterns found:\n${failures.join('\n')}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Add package script**

Modify `package.json`:

```json
"lint": "oxlint src && npm run lint:no-providers && npm run lint:remotion-animation",
"lint:remotion-animation": "node scripts/check-remotion-animation.mjs"
```

- [ ] **Step 5: Add container Vitest static guard**

Create `container/render/remotion/SpoooolAnimation.static.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const forbidden = [
  /\btransition\s*:/,
  /\banimation\s*:/,
  /@keyframes\b/,
  /\banimate-/,
  /\btransition-/,
  /\bduration-/,
  /\bease-/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(tsx|ts)$/.test(entry.name) ? [full] : [];
  });
}

describe('SpoooolAnimation Remotion constraints', () => {
  it('uses frame-driven Remotion animation only', () => {
    const root = path.resolve(__dirname);
    const targets = [path.join(root, 'SpoooolAnimation.tsx'), ...files(path.join(root, 'animation'))];
    const offenders = targets.filter((file) => forbidden.some((pattern) => pattern.test(fs.readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 6: Verify static checks pass**

Run:

```bash
npm test -- scripts/check-remotion-animation.test.mjs
npm run lint:remotion-animation
cd container/render && npm test -- remotion/SpoooolAnimation.static.test.ts
```

Expected: all PASS.

### Task 4: Container Asset Staging

**Files:**
- Modify: `container/render/src/render.ts`
- Modify: `container/render/src/render.test.ts`

- [ ] **Step 1: Write failing asset staging test**

Add a test to `container/render/src/render.test.ts`:

```ts
it('stages animation assets into public/{jobId}/ and injects r2Path', async () => {
  const downloaded: Array<{ key: string; dest: string }> = [];
  const renderer: RemotionRenderer = {
    bundle: vi.fn(async () => '/bundle'),
    selectComposition: vi.fn(async () => ({ id: 'spooool-animation', durationInFrames: 150, fps: 30, width: 1920, height: 1080 })),
    renderMedia: vi.fn(async () => {}),
  };
  await renderJob(
    {
      jobId: 'j_anim',
      takeKeys: [],
      compositionProps: {
        compositionId: 'spooool-animation',
        animation: { version: 1, title: 'x', fps: 30, width: 1920, height: 1080, durationFrames: 150, background: { kind: 'solid', color: '#000000' }, scenes: [] },
        assets: [{ assetId: 'a_img', r2Key: 'studio/images/a_img.jpg', kind: 'image' }],
      },
      onProgress: () => {},
    },
    {
      renderer,
      downloadTake: vi.fn(async (key: string, dest: string) => { downloaded.push({ key, dest }); }),
      tmpDir: '/tmp',
      publicDir: '/bundle/public',
      remotionEntry: '/remotion/index.ts',
    },
  );

  expect(downloaded).toContainEqual({ key: 'studio/images/a_img.jpg', dest: '/bundle/public/j_anim/a_img.jpg' });
  expect(renderer.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
    id: 'spooool-animation',
    inputProps: expect.objectContaining({
      assets: [expect.objectContaining({ assetId: 'a_img', r2Path: 'j_anim/a_img.jpg' })],
    }),
  }));
});
```

- [ ] **Step 2: Run render tests and confirm failure**

Run: `cd container/render && npm test -- src/render.test.ts`

Expected: FAIL because `assets[]` are not staged yet.

- [ ] **Step 3: Implement asset staging helper**

In `container/render/src/render.ts`, add:

```ts
type CompositionAsset = { assetId?: string; r2Key?: string; r2Path?: string; kind?: 'image' | 'video' | 'audio' };

function extensionForR2Key(key: string, kind?: string): string {
  const ext = path.extname(key);
  if (ext) return ext;
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.jpg';
}

async function stageCompositionAssets(args: {
  assets: unknown;
  jobId: string;
  publicDir: string;
  downloadTake: (key: string, destPath: string) => Promise<void>;
}): Promise<CompositionAsset[] | undefined> {
  if (!Array.isArray(args.assets)) return undefined;
  return Promise.all(args.assets.map(async (raw) => {
    const asset = raw as CompositionAsset;
    if (!asset.assetId || !asset.r2Key) return asset;
    const filename = `${asset.assetId}${extensionForR2Key(asset.r2Key, asset.kind)}`;
    await args.downloadTake(asset.r2Key, path.join(args.publicDir, args.jobId, filename));
    return { ...asset, r2Path: `${args.jobId}/${filename}` };
  }));
}
```

Call it before `selectComposition`, mutate the local `props` copy, and keep existing audio staging behavior intact.

- [ ] **Step 4: Preserve legacy fallback behavior**

Keep this invariant unchanged in `render.ts`:

```ts
const compositionId = typeof props.compositionId === 'string' ? props.compositionId : 'spooool-video';
```

The existing test for legacy default composition must continue to pass.

- [ ] **Step 5: Verify container render tests pass**

Run: `cd container/render && npm test -- src/render.test.ts`

Expected: PASS.

### Task 5: Studio Animation Worker Route

**Files:**
- Create: `src/workers/studio-animation.ts`
- Create: `src/workers/studio-animation.test.ts`
- Modify: `src/workers/index.ts`
- Modify: `src/workers/render.ts`
- Modify: `src/workers/render.test.ts`

- [ ] **Step 1: Write failing route gate tests**

Create `src/workers/studio-animation.test.ts` with a Hono harness mirroring `src/workers/studio.test.ts`. Add tests for:

```ts
describe('POST /api/studio/animation gates', () => {
  it('401 when unauthenticated', async () => {
    expect((await postAnimation(null, { prompt: 'make an animation' }).res).status).toBe(401);
  });

  it('403 when email is not verified', async () => {
    expect((await postAnimation(unverifiedUser, { prompt: 'make an animation' }).res).status).toBe(403);
  });

  it('400 on invalid body', async () => {
    expect((await postAnimation(verifiedUser, { prompt: 'a'.repeat(2049) }).res).status).toBe(400);
  });

  it('429 when rate limited before model calls', async () => {
    const { res, aiRun } = await postAnimation(verifiedUser, { prompt: 'make an animation' }, { RATE_LIMITER: rejectingRateLimiter() });
    expect(res.status).toBe(429);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run route tests and confirm failure**

Run: `npm test -- src/workers/studio-animation.test.ts`

Expected: FAIL because `studio-animation.ts` does not exist.

- [ ] **Step 3: Implement route shell**

Create `src/workers/studio-animation.ts`:

```ts
import { chat, generateImage, generateSpeech } from '@tanstack/ai';
import { Hono } from 'hono';
import { STUDIO_GEN_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';
import { gatewayChat, gatewayImage, gatewayTts, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_TTS_MODEL, type AiGatewayEnv, type AiGatewayMode } from './ai-gateway';
import { aiCostStatement, writeAiCost } from './ai-costs';
import { submitRenderJob, type RenderEnv } from './render';
import { animationRequestSchema, parseAnimationProjectSpec, dimensionsForAspectRatio } from './animation-scene-schema';

export interface StudioAnimationEnv extends RenderEnv {
  RATE_LIMITER?: DurableObjectNamespace;
  AI_GATEWAY_MODE?: AiGatewayMode;
  DB: D1Database;
  VIDEOS: R2Bucket;
}

type SessionUser = { id: string; emailVerified: boolean };
type Variables = { user: SessionUser | null };

export const studioAnimationRoutes = new Hono<{ Bindings: StudioAnimationEnv; Variables: Variables }>();
```

Implement `POST /api/studio/animation` with the same gate order as `studio.ts`: auth, verified email, rate limit, JSON parse, body schema.

- [ ] **Step 4: Write failing successful dispatch test**

Add a test where `env.AI.run` returns a valid JSON plan. Assert:

- Status `202`.
- Response body `{ jobId, status: 'queued', estimate: { durationSeconds, estimatedCostUsd }, generatedAssetCount: 0 }`.
- Container dispatch body includes `takeKeys: []`.
- `compositionProps.compositionId` is `spooool-animation`.
- `compositionProps.animation.width` and `height` match requested aspect ratio.
- `render_jobs.composition_spec` contains sanitized prompt metadata.

- [ ] **Step 5: Implement plan generation**

Implement:

```ts
async function generateAnimationPlan(args: {
  env: StudioAnimationEnv;
  prompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds: 15 | 30 | 45 | 60 | 90;
  style: 'clean' | 'playful' | 'cinematic' | 'technical' | 'social';
  useGeneratedImages: boolean;
}): Promise<AnimationProjectSpec>
```

Use `chat({ adapter: gatewayChat(args.env as unknown as AiGatewayEnv), systemPrompts: [systemPrompt], messages: [{ role: 'user', content: userPrompt }], outputSchema: animationProjectSpecSchema })`. The system prompt must include:

- Return JSON only.
- Use schema fields exactly.
- Do not generate code.
- Keep motion physically plausible and frame-driven.
- Use only `asset:hero-1`, `asset:background-1`, and similar asset placeholders when images are requested.
- Do not include video layers in the first slice unless the prompt references an existing ready generated video asset.

Normalize dimensions after model output using `dimensionsForAspectRatio()` and requested duration if the model chooses valid scenes whose dimensions differ from the request. Reject plans that still violate the schema after normalization.

- [ ] **Step 6: Implement exactly one repair attempt**

If the first generated plan fails `parseAnimationProjectSpec`, call `chat()` one more time with:

```ts
const repairPrompt = `The previous JSON failed validation with these issues:\n${issues}\n\nReturn a corrected JSON object only. Preserve the user's prompt, aspect ratio, duration, and style.`;
```

If the repair attempt fails, return `502 { error: 'Animation plan failed validation. Try a simpler prompt.' }` without dispatching a render job.

- [ ] **Step 7: Write failing image asset tests**

Add tests for `useGeneratedImages: true`:

- Valid plan with two image placeholders calls `generateImage` twice.
- Inserts two `generated_assets` rows with `kind='image'`, `source='image_gen'`, `status='ready'`, `spec_json` containing model id, original prompt, style, aspect ratio, duration target, placeholder, and plan hash.
- Writes R2 keys under `studio/images/{assetId}.jpg`.
- Rewrites animation layer `assetId` values to concrete generated asset ids.
- Caps generated images at four and fails cleanly when model emits five placeholders.

- [ ] **Step 8: Implement image generation helper**

Implement a local helper in `studio-animation.ts` that mirrors `studio.ts:73-120`:

```ts
async function generateAnimationImageAsset(args: {
  env: StudioAnimationEnv;
  userId: string;
  prompt: string;
  specJson: Record<string, unknown>;
}): Promise<{ assetId: string; r2Key: string; kind: 'image' }>
```

Use `generateImage({ adapter: gatewayImage(args.env as unknown as AiGatewayEnv, DEFAULT_IMAGE_MODEL), prompt })`, decode `b64Json` with `atob`, write `studio/images/{assetId}.jpg`, insert `generated_assets`, and write an `ai_costs` row with `op='image_gen'`, `route='dynamic/image_gen'`, `unitKind='images'`, `units=1`.

- [ ] **Step 9: Write failing TTS tests**

Add tests for `voiceover: 'warm'`:

- Generates a narration script shorter than 2,000 characters.
- Calls `generateSpeech({ adapter: gatewayTts(...), text, voice, format: 'mp3' })`.
- Writes `recorder/tts/{jobId}.mp3` to R2 with `audio/mpeg`.
- Passes `compositionProps.audio.r2Key` to `submitRenderJob`.
- Writes an `ai_costs` row with `op='tts_gen'`, `unitKind='characters'`.

- [ ] **Step 10: Implement TTS helper**

Implement:

```ts
function voiceToSpeaker(voiceover: 'warm' | 'neutral' | 'energetic'): string {
  if (voiceover === 'warm') return 'asteria-en';
  if (voiceover === 'energetic') return 'orion-en';
  return 'arcas-en';
}
```

Generate narration text with `gatewayChat()` from the validated plan, then synthesize through `generateSpeech({ adapter: gatewayTts(...), text, voice: voiceToSpeaker(...), format: 'mp3' })`. Decode base64 MP3 bytes and write to `recorder/tts/{jobId}.mp3`.

- [ ] **Step 11: Write failing cost and render metadata tests**

Assert the happy path writes:

- `ai_costs.op='animation_plan'`
- `ai_costs.op='animation_render_estimate'`
- `render_jobs.composition_spec.compositionProps.studio.prompt`
- `render_jobs.composition_spec.compositionProps.studio.style`
- `render_jobs.composition_spec.compositionProps.studio.aspectRatio`
- `render_jobs.composition_spec.compositionProps.studio.durationSeconds`
- `render_jobs.composition_spec.compositionProps.studio.planHash`

- [ ] **Step 12: Implement cost and metadata writes**

Use `crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(animation)))` to compute a stable hex `planHash`. Estimate costs with constants:

```ts
const EST_USD_ANIMATION_PLAN = 0.002;
const EST_USD_PER_IMAGE = 0.0013;
const EST_USD_TTS_BASE = 0.001;
const EST_USD_RENDER_BASE = 0.01;
```

Dispatch:

```ts
const { jobId } = await submitRenderJob({
  userId: user.id,
  takeKeys: [],
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
```

Return status `202`.

- [ ] **Step 13: Mount route in Worker index**

Modify `src/workers/index.ts`:

```ts
import { studioAnimationRoutes, type StudioAnimationEnv } from './studio-animation';
```

Add `StudioAnimationEnv` to `EnvBindings` and route before `studioRoutes`:

```ts
app.route('/', studioAnimationRoutes);
app.route('/', studioRoutes);
```

- [ ] **Step 14: Allow direct render API to accept empty takes**

Modify `src/workers/render.ts`:

```ts
const createBodySchema = z.object({
  takeKeys: z.array(z.string().min(1)),
  compositionProps: z.object({}).passthrough(),
});
```

Add a test to `src/workers/render.test.ts` proving `POST /api/render/jobs` accepts `{ takeKeys: [], compositionProps: { compositionId: 'spooool-animation' } }`.

- [ ] **Step 15: Mark completed animation videos as AI-generated**

Modify the `/api/render/jobs/:id/complete` `INSERT INTO videos` logic. Parse `job.composition_spec`, detect `compositionProps.compositionId === 'spooool-animation'`, and insert:

```sql
INSERT INTO videos (id, user_id, title, description, r2_key, bytes, status, view_count, ai_generated, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 0, 'queued', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
```

Bind `1` for animation jobs and `0` for legacy jobs.

- [ ] **Step 16: Verify Worker tests pass**

Run:

```bash
npm test -- src/workers/animation-scene-schema.test.ts src/workers/studio-animation.test.ts src/workers/render.test.ts
npm run type-check
npm run lint:no-providers
```

Expected: all PASS.

### Task 6: AI Studio Client and UI

**Files:**
- Modify: `src/frontend/studio/lib/studio-client.ts`
- Create: `src/frontend/studio/AnimationPanel.tsx`
- Create: `src/frontend/studio/AnimationPanel.dom.test.tsx`
- Modify: `src/frontend/studio/index.tsx`
- Modify: `src/frontend/pages/Studio.tsx`
- Modify: `src/frontend/studio/AIStudio.dom.test.tsx`

- [ ] **Step 1: Write failing client helper tests through panel DOM**

Create `src/frontend/studio/AnimationPanel.dom.test.tsx` with happy-dom tests that mount the panel, submit a prompt, and assert the request payload:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { AnimationPanel } from './AnimationPanel';

describe('AnimationPanel', () => {
  it('submits animation options and links to the completed video', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'j_anim', status: 'queued', estimate: { durationSeconds: 15, estimatedCostUsd: 0.013 }, generatedAssetCount: 0 }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j_anim', status: 'rendering', progress: 40, videoId: null, error: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j_anim', status: 'completed', progress: 100, videoId: 'v_anim', error: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const div = document.createElement('div');
    document.body.appendChild(div);
    const root = ReactDOM.createRoot(div);
    act(() => root.render(<MemoryRouter><AnimationPanel /></MemoryRouter>));

    const textarea = div.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!;
    await act(async () => {
      textarea.value = 'Make a 15 second launch animation';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const duration = div.querySelector<HTMLSelectElement>('select[name="durationSeconds"]')!;
    await act(async () => {
      duration.value = '15';
      duration.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      div.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/studio/animation', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      prompt: 'Make a 15 second launch animation',
      durationSeconds: 15,
      aspectRatio: '16:9',
      style: 'clean',
      voiceover: 'none',
      useGeneratedImages: false,
    });
  });
});
```

- [ ] **Step 2: Run panel tests and confirm failure**

Run: `npm test -- src/frontend/studio/AnimationPanel.dom.test.tsx`

Expected: FAIL because `AnimationPanel` does not exist.

- [ ] **Step 3: Add Studio client helpers**

Modify `src/frontend/studio/lib/studio-client.ts`:

```ts
export interface AnimationRequestBody {
  prompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds: 15 | 30 | 45 | 60 | 90;
  style: 'clean' | 'playful' | 'cinematic' | 'technical' | 'social';
  voiceover: 'none' | 'warm' | 'neutral' | 'energetic';
  useGeneratedImages: boolean;
}

export interface AnimationQueuedResponse {
  jobId: string;
  status: 'queued';
  estimate: { durationSeconds: number; estimatedCostUsd: number };
  generatedAssetCount: number;
}

export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey?: string | null;
  videoId?: string | null;
  error?: string | null;
}

export async function postAnimation(body: AnimationRequestBody): Promise<AnimationQueuedResponse> {
  const route = '/api/studio/animation';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as AnimationQueuedResponse;
}

export async function getRenderJob(jobId: string): Promise<RenderJobStatus> {
  const route = `/api/render/jobs/${jobId}`;
  const res = await timedFetch(route, { method: 'GET' });
  await throwIfNotOk(res, route);
  return (await res.json()) as RenderJobStatus;
}
```

- [ ] **Step 4: Implement `AnimationPanel`**

Create `src/frontend/studio/AnimationPanel.tsx` with:

- Controlled form fields for prompt, aspect ratio, duration, style, voiceover, and generated images.
- Prompt `maxLength={2048}` and required validation.
- Submit button disabled while queued/rendering.
- Stage list: `planning`, `asset_generation`, `voiceover`, `rendering`, `encoding`, `ready`.
- Cost estimate display after queueing: `Estimated cost: $${estimate.estimatedCostUsd.toFixed(3)}`.
- Generated asset count display after queueing.
- Poll `getRenderJob(jobId)` every 2 seconds while status is `queued` or `rendering`.
- Show `/watch/{videoId}` link when `videoId` appears.
- Show user-safe errors from `ApiError`, including specific copy for 429 and 413.

The first UI slice does not need a browser timeline, scrubber, clip editing, or drag/drop.

- [ ] **Step 5: Mount panel in Studio root**

Modify `src/frontend/studio/index.tsx`:

```tsx
import { AnimationPanel } from './AnimationPanel';
import { AIStudio } from './AIStudio';
import { ImagePanel } from './ImagePanel';

export function StudioRoot({ videoId }: { videoId?: string } = {}): JSX.Element {
  return (
    <div className="stack-lg">
      <section className="stack-sm">
        <h2 className="ds-h3">Animated video</h2>
        <AnimationPanel />
      </section>
      <section className="stack-sm">
        <h2 className="ds-h3">Chat</h2>
        <AIStudio />
      </section>
      <section className="stack-sm">
        <h2 className="ds-h3">Image generation</h2>
        <ImagePanel videoId={videoId} />
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Update page copy**

Modify `src/frontend/pages/Studio.tsx` page lede:

```tsx
<p className="ds-lede">Create prompt-generated animations, brainstorm ideas, and generate thumbnails with AI Studio.</p>
```

- [ ] **Step 7: Update existing broad DOM smoke tests**

Modify `src/frontend/studio/AIStudio.dom.test.tsx` so the empty-state smoke test expects the new animation section and still confirms chat renders:

```ts
expect(container!.textContent).toContain('Animated video');
expect(container!.textContent).toContain('Ask for video ideas');
```

- [ ] **Step 8: Verify frontend tests pass**

Run:

```bash
npm test -- src/frontend/studio/AnimationPanel.dom.test.tsx src/frontend/studio/AIStudio.dom.test.tsx src/frontend/studio/ImagePanel.dom.test.tsx
npm run type-check
```

Expected: all PASS.

### Task 7: End-to-End Verification and CI Assertions

**Files:**
- Modify only if failures identify a missing import, test fixture, or script wiring from earlier tasks.

- [ ] **Step 1: Run targeted Worker tests**

Run:

```bash
npm test -- src/workers/animation-scene-schema.test.ts src/workers/studio-animation.test.ts src/workers/render.test.ts src/workers/ai-gateway.test.ts src/workers/studio.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run targeted frontend tests**

Run:

```bash
npm test -- src/frontend/studio/AnimationPanel.dom.test.tsx src/frontend/studio/AIStudio.dom.test.tsx src/frontend/studio/ImagePanel.dom.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run targeted container tests**

Run:

```bash
cd container/render && npm test -- src/render.test.ts remotion/SpoooolAnimation.test.tsx remotion/SpoooolAnimation.static.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run static Remotion guard**

Run:

```bash
npm test -- scripts/check-remotion-animation.test.mjs
npm run lint:remotion-animation
```

Expected: PASS and no forbidden patterns reported.

- [ ] **Step 5: Run full root verification**

Run:

```bash
npm test
npm run lint
npm run type-check
npm run build
```

Expected: PASS.

- [ ] **Step 6: Run full container verification**

Run:

```bash
cd container/render && npm test && npm run build
```

Expected: PASS.

- [ ] **Step 7: Optional one-frame Remotion still smoke**

Run this locally when Remotion dependencies and browser binaries are available:

```bash
cd container/render && npx remotion still remotion/index.ts spooool-animation --props='{"compositionId":"spooool-animation","animation":{"version":1,"title":"Smoke","fps":30,"width":1920,"height":1080,"durationFrames":150,"background":{"kind":"solid","color":"#0a84ff"},"scenes":[{"id":"scene-1","startFrame":0,"durationFrames":150,"layout":"title","layers":[{"kind":"text","id":"headline","startFrame":0,"durationFrames":150,"x":160,"y":380,"width":1600,"height":240,"text":"Smoke test","fontSize":96,"fontWeight":700,"align":"center","color":"#ffffff","motion":[{"property":"opacity","from":0,"to":1,"startFrame":0,"durationFrames":30,"easing":"easeOut"}]}]}]},"assets":[],"brand":{"color":"#0a84ff"}}' --frame=30 --scale=0.25 /tmp/spooool-animation-smoke.png
```

Expected: command exits `0` and writes `/tmp/spooool-animation-smoke.png`.

- [ ] **Step 8: Manual smoke in staging**

Use a verified user in staging:

1. Open `/studio`.
2. Submit a 15-second square animation with no voiceover and no generated images.
3. Confirm the panel shows planning/rendering/ready progress and links to `/watch/{videoId}`.
4. Confirm the video plays.
5. Confirm `render_jobs.composition_spec` contains `compositionId: "spooool-animation"` and `studio.planHash`.
6. Confirm `videos.ai_generated = 1` for the completed video row.
7. Confirm `ai_costs` includes `animation_plan` and `animation_render_estimate`.
8. Submit a 30-second landscape animation with `voiceover: warm`; confirm `recorder/tts/{jobId}.mp3` was staged and audio is present.
9. Submit a 30-second vertical animation with generated images enabled; confirm `generated_assets` rows are ready and the render uses staged image paths.

## Critical Details

- The model never emits code. It emits JSON validated by Worker Zod schemas and defensively validated again in the container.
- Remotion composition code must use frame-driven animation with `useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, and `Sequence`.
- Remotion composition code must not use CSS transitions, CSS animations, `@keyframes`, Tailwind animation classes, browser timers, `Date.now()`, `Math.random()`, DOM event handlers, or request-time mutable state.
- Text layers render as React text content, never as HTML.
- Remote URLs are not passed directly into Remotion. Worker code writes generated media to R2 and the container stages R2 objects into `public/{jobId}/`.
- Asset ownership is checked in the Worker before dispatch. Generated image assets are created for the current user in the same route; ready video asset support is renderer-defensive only in this first slice.
- Safety failures should return generic user-facing messages. Local validation failures can identify invalid field classes such as duration, color, or layer bounds.
- If planning fails before a render job exists, return a typed 4xx or 5xx from `/api/studio/animation`. If dispatch fails after `submitRenderJob` inserts a row, rely on `submitRenderJob` to mark the row failed.
- Cost/provenance is required for every expensive operation: `animation_plan`, `image_gen`, `tts_gen`, and `animation_render_estimate`.
- Keep E10 timeline concepts out of the UI and route behavior. The schema is timeline-shaped for future reuse, but this first slice creates standalone rendered videos only.
