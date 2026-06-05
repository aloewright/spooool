# AI Studio Prompt-Generated Remotion Animation Design

**Status:** Approved design spec
**Date:** 2026-06-05
**Scope:** AI Studio creates new standalone animated videos from prompts using Remotion. This is the first slice before uploaded-video timeline editing.

## Goal

Let a verified user open AI Studio, describe a short animated video, optionally use generated image/video/audio assets, and receive a rendered MP4 that flows through the existing Spooool render job, Remotion container, R2, encoding, Stream, and `videos` paths.

The core product promise is prompt → typed animation scene plan → `compositionId: 'spooool-animation'` → rendered standalone video. The scene schema is intentionally close to an edit decision list so it can later become E10 timeline clips, but this slice does not build the timeline editor.

## Non-Goals

- No uploaded-video timeline editing, trimming, splitting, clip handles, drag-and-drop sequencing, or browser scrubber in this slice.
- No server-side Stream concatenation. The render container remains the only assembly path for final MP4s.
- No free-form React/TSX generation by the model. The model generates JSON that is validated and rendered by trusted composition code.
- No CSS animation system in Remotion. Composition code must not use CSS transitions, CSS animations, or Tailwind animation classes.
- No new render state machine. Reuse `render_jobs`, `submitRenderJob`, container callbacks, `videos` insertion, `VIDEO_ENCODING`, and Stream handoff.
- No attempt to replace the existing `spooool-explainer` prompt-to-video flow immediately. `spooool-animation` is a richer standalone animation path that can run beside it and eventually absorb it.

## UX Flow

1. The user opens `/studio` and chooses **Animated video**.
2. The form asks for:
   - Prompt: required, max 2,048 characters.
   - Aspect ratio: `16:9`, `9:16`, or `1:1`; default `16:9`.
   - Duration target: 15, 30, 45, 60, or 90 seconds; default 30.
   - Style preset: `clean`, `playful`, `cinematic`, `technical`, or `social`; default `clean`.
   - Voiceover: `none`, `warm`, `neutral`, or `energetic`; default `none`.
   - Optional generated assets toggle: images only in the first slice; generated video b-roll can be referenced after the existing `AI_GEN` queue is stable enough for this route.
3. On submit, the UI shows the same kind of stage progress as prompt-to-video:
   - `planning`
   - `asset_generation`
   - `voiceover`
   - `rendering`
   - `encoding`
   - `ready`
4. The route returns a `jobId` as soon as the render job is queued. The UI polls `/api/render/jobs/:id` or a Studio alias until it receives `videoId`, then links to `/watch/:videoId`.
5. The user's library sees the output as a normal Spooool video with `ai_generated = 1` when that column is available; otherwise the generated status is stored in `composition_spec` and `generated_assets`.

## Architecture

```text
Browser /studio
  POST /api/studio/animation
    prompt + animation options
      |
      v
Hono Worker
  validate prompt/options
  rate-limit with STUDIO_GEN_BUCKET
  generate typed AnimationSceneSpec via gatewayChat()
  optionally create generated_assets rows for image prompts
  optionally synthesize TTS via gatewayTts()
  insert/update ai_costs rows
  submitRenderJob({
    takeKeys: [],
    compositionProps: {
      compositionId: 'spooool-animation',
      animation: AnimationProjectSpec,
      assets: AnimationAssetRef[],
      audio?: { r2Key },
      brand: { color: '#0a84ff' }
    }
  })
      |
      v
Render container
  container/render/src/render.ts
    stages R2 assets into remotion/public/{jobId}/
    rewrites r2Key refs to staticFile paths
    selectComposition(id='spooool-animation')
    renderMedia()
      |
      v
Worker callbacks
  /api/render/jobs/:id/progress
  /api/render/jobs/:id/complete
    videos row -> VIDEO_ENCODING -> Stream
```

New code should follow current ownership boundaries:

- Worker orchestration lives under `src/workers/studio-animation.ts` or a focused sibling of `studio.ts`, then mounts from `src/workers/index.ts`.
- Shared AI transport stays in `src/workers/ai-gateway.ts`; do not call providers directly.
- Cost writes reuse `src/workers/ai-costs.ts`.
- Render dispatch reuses `src/workers/render.ts` and `submitRenderJob`.
- Composition code lives in `container/render/remotion/SpoooolAnimation.tsx` and is registered from `container/render/remotion/Root.tsx` as `id="spooool-animation"`.
- Container asset staging extends `container/render/src/render.ts` without changing the callback contract in `container/render/src/server.ts`.

## Animation Scene Schema

The model outputs a JSON object called `AnimationProjectSpec`. Worker code validates it with Zod before any render job is dispatched. Invalid output gets one structured re-prompt; a second invalid output fails the job with a user-safe message.

```ts
type AnimationProjectSpec = {
  version: 1;
  title: string;
  fps: 30;
  width: 1920 | 1080;
  height: 1080 | 1920;
  durationFrames: number;
  background: {
    kind: 'solid' | 'gradient';
    color?: string;
    from?: string;
    to?: string;
    direction?: 'vertical' | 'horizontal' | 'diagonal';
  };
  scenes: AnimationSceneSpec[];
};

type AnimationSceneSpec = {
  id: string;
  startFrame: number;
  durationFrames: number;
  layout: 'title' | 'split' | 'centerpiece' | 'captioned-asset' | 'outro';
  background?: AnimationProjectSpec['background'];
  layers: AnimationLayerSpec[];
  transitionOut?: {
    kind: 'cut' | 'fade' | 'wipe';
    durationFrames: number;
  };
};

type AnimationLayerSpec =
  | TextLayerSpec
  | ShapeLayerSpec
  | ImageLayerSpec
  | VideoLayerSpec;

type BaseLayerSpec = {
  id: string;
  startFrame: number;
  durationFrames: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  zIndex?: number;
  motion?: FrameDrivenMotionSpec[];
};

type TextLayerSpec = BaseLayerSpec & {
  kind: 'text';
  text: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700 | 800;
  align: 'left' | 'center' | 'right';
  color: string;
};

type ShapeLayerSpec = BaseLayerSpec & {
  kind: 'shape';
  shape: 'rect' | 'roundRect' | 'circle' | 'line';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
};

type ImageLayerSpec = BaseLayerSpec & {
  kind: 'image';
  assetId: string;
  fit: 'cover' | 'contain';
};

type VideoLayerSpec = BaseLayerSpec & {
  kind: 'video';
  assetId: string;
  fit: 'cover' | 'contain';
  trimBeforeFrames?: number;
  volume?: number;
};

type FrameDrivenMotionSpec = {
  property: 'x' | 'y' | 'scale' | 'rotate' | 'opacity';
  from: number;
  to: number;
  startFrame: number;
  durationFrames: number;
  easing: 'linear' | 'easeOut' | 'easeInOut' | 'spring';
};
```

Validation rules:

- `fps` is always 30 for the first slice.
- `durationFrames` must equal the max end frame of all scenes and must be between 150 and 2,700 frames.
- Scenes must be sorted, non-overlapping, and cover the full video with no negative frames.
- Layer frames are relative to the scene and must stay within the scene duration.
- Text is capped at 180 characters per layer and 1,200 total visible characters per video.
- Colors must be hex, `rgb()`, or `rgba()` strings. Named CSS colors are rejected to keep generated specs deterministic.
- Asset references must resolve to generated assets owned by the current user, with `status='ready'`.
- Motion specs are declarative frame math only. They describe values for Remotion to drive via `useCurrentFrame()`, `interpolate()`, `spring()`, and `Sequence`.

The schema maps cleanly into future E10 clips:

- `AnimationSceneSpec` becomes a timeline clip group.
- `AnimationLayerSpec` becomes clip content or overlay tracks.
- `startFrame`, `durationFrames`, `trimBeforeFrames`, and `transitionOut` are already timeline-native.
- `assetId` can resolve to the same `generated_assets` table used by AI Studio and later by the editor.

## AI Generation Flow

`POST /api/studio/animation` accepts:

```ts
{
  prompt: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: 15 | 30 | 45 | 60 | 90;
  style?: 'clean' | 'playful' | 'cinematic' | 'technical' | 'social';
  voiceover?: 'none' | 'warm' | 'neutral' | 'energetic';
  useGeneratedImages?: boolean;
}
```

Server flow:

1. Authenticate the user and require verified email, matching `studio.ts`.
2. Apply `STUDIO_GEN_BUCKET` and reject over-limit requests before model calls.
3. Ask `gatewayChat()` for structured `AnimationProjectSpec` JSON. The system prompt must say:
   - Return JSON only.
   - Use the schema fields exactly.
   - Do not generate code.
   - Keep motion physically plausible and frame-driven.
   - Use only asset placeholders in the form `asset:hero-1`, `asset:background-1` when images are requested.
4. Validate the plan. If placeholders are present and `useGeneratedImages` is true, generate those image assets through the existing `gatewayImage()`/`generated_assets` pattern in `studio.ts`.
5. Rewrite generated asset placeholders to concrete `assetId` values.
6. If `voiceover !== 'none'`, create a concise narration script from the same prompt and plan, call `gatewayTts()`, write `studio/audio/{jobId}.mp3` or `recorder/tts/{jobId}.mp3` to R2, and pass `{ audio: { r2Key } }` into `compositionProps`.
7. Insert `ai_costs` rows for text planning, image generation, TTS, and render estimates. Store route annotations as gateway-routed operations even when the implementation uses `env.AI.run('@cf/...', ..., { gateway: { id: 'x' } })`.
8. Dispatch `submitRenderJob` with `takeKeys: []` and `compositionProps.compositionId = 'spooool-animation'`.

The route should return:

```ts
{
  jobId: string;
  status: 'queued';
  estimate: {
    durationSeconds: number;
    estimatedCostUsd: number;
  };
}
```

## Render / Container Integration

Register a new composition in `container/render/remotion/Root.tsx`:

- `id="spooool-animation"`
- `component={SpoooolAnimation}`
- `fps={30}`
- default dimensions `1920x1080`
- default props containing an empty valid `AnimationProjectSpec`
- `calculateMetadata` reads `props.animation.durationFrames`, `width`, and `height`

`SpoooolAnimation` renders:

- One `<Sequence>` per scene.
- One child component per layer.
- Text and shapes with inline style values derived from validated props.
- Images with Remotion `<Img>`.
- Video assets with Remotion `<Video>` or `<OffthreadVideo>` where decoding stability needs it.
- Optional audio with Remotion `<Audio>`.

Dynamic metadata is required so the render dimensions and duration come from validated props. The renderer must clamp to supported dimension presets:

- `16:9`: `1920x1080`
- `9:16`: `1080x1920`
- `1:1`: `1080x1080`

The existing `container/render/src/render.ts` already:

- bundles once per renderer instance,
- stages recorder takes into `remotion/public/{jobId}/`,
- stages `audio.r2Key` into `remotion/public/{jobId}/audio.mp3`,
- selects `props.compositionId` with fallback to `spooool-video`.

This slice extends that staging logic to accept:

```ts
type AnimationAssetRef = {
  assetId: string;
  r2Key: string;
  kind: 'image' | 'video' | 'audio';
};
```

Each asset is downloaded to `public/{jobId}/{assetId}.{ext}`, and the container rewrites `compositionProps.assets` to include `r2Path`. The composition references staged files with `staticFile(r2Path)`.

## Remotion Rendering Rules

These rules are hard requirements for every `spooool-animation` composition component:

- All motion must be frame-driven with Remotion primitives: `useCurrentFrame()`, `useVideoConfig()`, `interpolate()`, `spring()`, `Sequence`, and related Remotion utilities.
- CSS transitions are forbidden in rendered composition code.
- CSS animations and `@keyframes` are forbidden in rendered composition code.
- Tailwind animation classes are forbidden in rendered composition code, including classes such as `animate-*`, `transition-*`, `duration-*`, `ease-*`, and generated utility combinations intended to animate during browser runtime.
- Composition code may use static class names only for non-animated styling if the container build already supports them, but inline styles are preferred for generated scene rendering because all values are validated props.
- Use Remotion media components for media: `<Img>`, `<Video>`, `<OffthreadVideo>`, and `<Audio>`.
- Use `staticFile()` for staged public assets under `remotion/public/{jobId}/`.
- Do not use timers, `Date.now()`, random values during render, DOM event handlers, or request-time state to drive visuals. Given the same props and frame number, rendered pixels must be deterministic.

The model never chooses implementation primitives. It only emits `FrameDrivenMotionSpec`, and trusted React components convert that spec into frame math.

## Asset Handling

Assets come from `generated_assets` or TTS output:

- Image generation uses `POST /api/studio/image` behavior as the reference: decode model output, write to R2, insert `generated_assets(kind='image', source='image_gen', status='ready')`, and account for storage.
- Generated video b-roll can be referenced only after `generated_assets.kind='video'` is `ready` and has an R2 key. The first implementation can omit video layers from generated plans until the AI video queue is stable in production.
- TTS audio is stored in R2 with `Content-Type: audio/mpeg` and staged by the render container into public assets.
- Remote URLs are not passed directly to Remotion in this slice. Worker code stages all user-owned or generated media into R2 first, and the container stages those R2 objects into `public/{jobId}`.
- Asset lifecycle should mirror existing generated asset retention and storage quota behavior. Temporary TTS objects can use the existing `recorder/tts/` prefix until a Studio-specific lifecycle prefix is configured; the spec does not require a new bucket.

## Cost / Observability

The first implementation must make every expensive operation visible:

- `ai_costs` row per generation activity:
  - `animation_plan`
  - `image_gen`
  - `tts_gen`
  - `animation_render_estimate`
- `generated_assets.spec_json` stores the prompt, model id, style preset, aspect ratio, duration target, and the final validated scene plan hash.
- `render_jobs.composition_spec` stores the dispatched `compositionProps`, including `compositionId: 'spooool-animation'`, sanitized prompt metadata, asset ids, and final duration/dimensions.
- Worker logs include `jobId`, `userId`, `assetId`, `stage`, `model`, `gatewayId`, and failure class. Logs must not include full prompts after validation failure if the failure may be safety-related.
- AI calls continue through `src/workers/ai-gateway.ts`; plain provider SDKs and direct provider URLs remain forbidden.
- The UI shows an estimated cost before submit and the actual generated asset count after queueing.

Suggested initial estimates:

- Text plan: one `gatewayChat` structured call.
- Optional image generation: one to four images, capped by server validation.
- Optional TTS: one narration under 2,000 characters.
- Render: one Remotion container job, expected 15 to 90 seconds of output.

## Safety / Validation

Safety is enforced before model calls, after model calls, and before render dispatch:

- Prompt validation rejects empty prompts, prompts over 2,048 characters, and requests for disallowed content using the same safety language as existing create/studio routes.
- The structured plan is schema-validated and normalized on the Worker. The container should still defensively validate props with a local schema before rendering so malformed jobs fail clearly.
- Scene and layer caps:
  - max 12 scenes,
  - max 10 layers per scene,
  - max 2 video layers per video,
  - max 4 generated images per job,
  - max 90 seconds,
  - max 1080p dimensions.
- Asset ownership is checked in the Worker before render dispatch. The container receives R2 keys only after the Worker has verified current-user ownership.
- Text is sanitized as text content, never injected as HTML.
- Failure messages surfaced to users are generic for policy refusals and precise for local validation errors.
- A render job that fails during planning, asset generation, or TTS is marked failed in `render_jobs` if a row already exists; otherwise the Studio route returns a typed 4xx/5xx without creating an orphaned job.

## Testing Strategy

Unit tests:

- `src/workers/studio-animation.test.ts`
  - auth and verified-email gates,
  - request validation,
  - rate-limit behavior,
  - validated plan dispatches `compositionId: 'spooool-animation'`,
  - invalid model JSON gets one re-prompt then fails cleanly,
  - asset ownership is enforced.
- `src/workers/animation-scene-schema.test.ts`
  - duration and scene coverage,
  - layer frame bounds,
  - color validation,
  - asset placeholder rewrite,
  - max caps.
- `container/render/src/render.test.ts`
  - image/video assets are staged into `public/{jobId}`,
  - `r2Path` is injected,
  - `compositionId` selection still defaults to `spooool-video` for legacy jobs.
- `container/render/remotion/SpoooolAnimation.test.tsx`
  - metadata duration and dimensions match props,
  - empty default props render one valid frame,
  - text, image, shape, and audio layers render with synthetic props.

Static checks:

- Add or extend a test/lint check that scans `container/render/remotion/SpoooolAnimation*.tsx` for forbidden animation patterns:
  - `transition:`
  - `animation:`
  - `@keyframes`
  - `animate-`
  - `transition-`
  - browser timers in render components.

Integration checks:

- Mock AI Gateway and R2 to run `POST /api/studio/animation` through render dispatch without live model calls.
- Use a gated one-frame Remotion still render for `spooool-animation` with deterministic props.
- Add an env-gated smoke test that creates a 15-second animation from a fixed prompt and waits for a completed `videoId`; keep it out of default CI to avoid AI and container spend.

Manual smoke:

- Generate a 15-second square animation with no voiceover.
- Generate a 30-second landscape animation with voiceover.
- Generate a 30-second vertical animation with one generated image layer.
- Verify `/watch/:videoId` playback, cost ledger rows, `generated_assets` rows, and `render_jobs.composition_spec`.

## Rollout / Slices

1. **Schema and composition foundation**
   - Add `AnimationProjectSpec` validation.
   - Add `SpoooolAnimation` with text and shape layers only.
   - Register `spooool-animation` with dynamic metadata.
   - Add composition tests and forbidden-animation static check.

2. **Worker route and render dispatch**
   - Add `POST /api/studio/animation`.
   - Generate structured scene specs with `gatewayChat`.
   - Dispatch through `submitRenderJob`.
   - Store cost and render observability metadata.

3. **Image asset support**
   - Let the scene plan request a capped set of image placeholders.
   - Generate images through the existing Studio asset pattern.
   - Stage image assets in the render container and render them with `<Img>`.

4. **Voiceover support**
   - Generate narration from the validated plan.
   - Synthesize TTS through `gatewayTts`.
   - Stage audio and render with `<Audio>`.

5. **Video asset support**
   - Allow ready generated video assets as `VideoLayerSpec`.
   - Stage video assets in the render container.
   - Render with Remotion media components and frame-based trim props.

6. **UX polish and rollout controls**
   - Add the `/studio` animated-video panel.
   - Surface estimates, progress, and final watch link.
   - Gate with a feature flag or server-side allowlist while render cost and output quality are measured.

## Future Path Into E10 Timeline

This design deliberately stops short of a timeline editor, but it preserves the path:

- `AnimationProjectSpec.scenes` can be converted into E10 clip groups without changing frame math.
- `AnimationLayerSpec` can become overlay tracks, captions, generated image clips, or generated video clips.
- `transitionOut` is already clip-transition-shaped, but the first implementation should render only `cut`, `fade`, and simple `wipe` through frame-driven Remotion math. Rich timeline transitions can later use the E10 transition system.
- `assetId` points at `generated_assets`, the same table E10 can use for b-roll and clips.
- A future `/edit/:videoId` action can import `render_jobs.composition_spec.animation` into an editable project instead of reconstructing clips from the rendered MP4.
- The render container stays R2-first, so future E10 Stream sources still need Worker-side pre-stage to R2 before Remotion render dispatch, matching the E10 design.

The first standalone animation slice is successful when a prompt-generated video can be created, rendered, watched, costed, and inspected without any timeline UI.
