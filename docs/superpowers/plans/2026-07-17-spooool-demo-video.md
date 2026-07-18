# Spooool Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Produce polished Spooool product-demo videos in 1920×1080 and 1080×1920 that show the real Studio workflow and end on “Where ideas become stories.”

**Architecture:** Capture deterministic screenshots from real Studio routes with Playwright and mocked API responses, then present those captures inside two independently composed Remotion timelines. Shared scene primitives provide framing, typography, cursor choreography, and brand transitions; format-specific scene layouts preserve legibility instead of cropping. A deterministic Node audio generator creates an original music-and-sound-design bed, and a programmatic renderer produces ignored H.264 deliverables plus QA stills.

**Tech Stack:** React 18, Remotion 4, `@remotion/media`, Playwright, Vitest, TypeScript, Node.js 24, FFmpeg/ffprobe.

**Global Constraints:** Follow `docs/superpowers/specs/2026-07-17-spooool-demo-video-design.md`. All visual motion must derive from `useCurrentFrame()`, `interpolate()`, `spring()`, and `<Sequence>`; use no CSS transitions, CSS animations, keyframes, Tailwind animation classes, timers, `Date`, or `Math.random`. Do not alter the interactive Studio product or show unavailable functionality. Do not access production data, credentials, or external media. Keep rendered videos and QA output under ignored `artifacts/`. Use the bundled Node 24 runtime:

```bash
export PATH=/Users/aloe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
```

---

## Task 1: Lock timeline contracts with tests

**Files:**

- Create: `container/render/remotion/demo/demo-timeline.ts`
- Create: `container/render/remotion/demo/demo-timeline.test.ts`

- [ ] **Step 1: Write the failing duration and continuity tests**

```ts
import { describe, expect, it } from "vitest";
import {
  DEMO_FPS,
  LANDSCAPE_DURATION,
  LANDSCAPE_SCENES,
  VERTICAL_DURATION,
  VERTICAL_SCENES,
  validateDemoTimeline,
} from "./demo-timeline";

describe("demo timelines", () => {
  it("uses the approved frame rate and exact durations", () => {
    expect(DEMO_FPS).toBe(30);
    expect(LANDSCAPE_DURATION).toBe(900);
    expect(VERTICAL_DURATION).toBe(660);
  });

  it.each([
    ["landscape", LANDSCAPE_SCENES, LANDSCAPE_DURATION],
    ["vertical", VERTICAL_SCENES, VERTICAL_DURATION],
  ] as const)("keeps the %s scenes contiguous", (_, scenes, duration) => {
    expect(validateDemoTimeline(scenes, duration)).toEqual([]);
    expect(scenes[0]?.from).toBe(0);
    expect(scenes.at(-1)!.from + scenes.at(-1)!.duration).toBe(duration);
  });

  it("keeps the approved scene order", () => {
    expect(LANDSCAPE_SCENES.map(({ key }) => key)).toEqual([
      "spark", "compose", "shape", "refine", "publish", "brand",
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails because the module is missing**

```bash
cd container/render
npm test -- remotion/demo/demo-timeline.test.ts
```

- [ ] **Step 3: Implement the approved frame map and validator**

```ts
export const DEMO_FPS = 30;
export const LANDSCAPE_DURATION = 900;
export const VERTICAL_DURATION = 660;

export type DemoFormat = "landscape" | "vertical";
export type DemoSceneKey = "spark" | "compose" | "shape" | "refine" | "publish" | "brand";
export type DemoScene = Readonly<{ key: DemoSceneKey; from: number; duration: number }>;

export const LANDSCAPE_SCENES: readonly DemoScene[] = [
  { key: "spark", from: 0, duration: 90 },
  { key: "compose", from: 90, duration: 150 },
  { key: "shape", from: 240, duration: 180 },
  { key: "refine", from: 420, duration: 210 },
  { key: "publish", from: 630, duration: 150 },
  { key: "brand", from: 780, duration: 120 },
] as const;

export const VERTICAL_SCENES: readonly DemoScene[] = [
  { key: "spark", from: 0, duration: 60 },
  { key: "compose", from: 60, duration: 120 },
  { key: "shape", from: 180, duration: 150 },
  { key: "refine", from: 330, duration: 150 },
  { key: "publish", from: 480, duration: 90 },
  { key: "brand", from: 570, duration: 90 },
] as const;

export const getDemoTimeline = (format: DemoFormat): readonly DemoScene[] =>
  format === "landscape" ? LANDSCAPE_SCENES : VERTICAL_SCENES;

export const validateDemoTimeline = (
  scenes: readonly DemoScene[],
  expectedDuration: number,
): string[] => {
  const errors: string[] = [];
  scenes.forEach((scene, index) => {
    const previous = scenes[index - 1];
    const expectedFrom = previous ? previous.from + previous.duration : 0;
    if (scene.from !== expectedFrom) errors.push(
      scene.key + " starts at " + scene.from + ", expected " + expectedFrom,
    );
    if (scene.duration <= 0) errors.push(scene.key + " must have a positive duration");
  });
  const last = scenes.at(-1);
  const end = last ? last.from + last.duration : 0;
  if (end !== expectedDuration) errors.push(
    "timeline ends at " + end + ", expected " + expectedDuration,
  );
  return errors;
};
```

- [ ] **Step 4: Run the focused test and commit**

```bash
npm test -- remotion/demo/demo-timeline.test.ts
git add container/render/remotion/demo/demo-timeline.ts container/render/remotion/demo/demo-timeline.test.ts
git commit -m "feat: define Spooool demo timelines"
```

Expected: all focused tests pass.

## Task 2: Define and validate deterministic capture assets

**Files:**

- Create: `container/render/remotion/demo/demo-assets.ts`
- Create: `container/render/remotion/demo/demo-assets.test.ts`
- Create: `studio/tests/e2e/demo-fixtures.ts`

- [ ] **Step 1: Write the failing asset-manifest test**

```ts
import { describe, expect, it } from "vitest";
import { DEMO_ASSETS, getRequiredDemoAssets } from "./demo-assets";

describe("demo assets", () => {
  it("declares every approved product moment and both audio beds", () => {
    expect(Object.keys(DEMO_ASSETS.screens)).toEqual([
      "home", "compose", "outline", "editor", "book", "publish",
    ]);
    expect(DEMO_ASSETS.audio).toEqual({
      landscape: "demo/audio/spooool-demo-landscape.wav",
      vertical: "demo/audio/spooool-demo-vertical.wav",
    });
    expect(new Set(getRequiredDemoAssets()).size).toBe(8);
  });
});
```

- [ ] **Step 2: Confirm the module-resolution failure**

```bash
cd container/render
npm test -- remotion/demo/demo-assets.test.ts
```

- [ ] **Step 3: Implement the immutable manifest**

```ts
export const DEMO_ASSETS = {
  screens: {
    home: "demo/screens/studio-home.png",
    compose: "demo/screens/studio-compose.png",
    outline: "demo/screens/studio-outline.png",
    editor: "demo/screens/studio-editor.png",
    book: "demo/screens/studio-book.png",
    publish: "demo/screens/studio-publish.png",
  },
  audio: {
    landscape: "demo/audio/spooool-demo-landscape.wav",
    vertical: "demo/audio/spooool-demo-vertical.wav",
  },
} as const;

export const getRequiredDemoAssets = (): string[] => [
  ...Object.values(DEMO_ASSETS.screens),
  ...Object.values(DEMO_ASSETS.audio),
];
```

- [ ] **Step 4: Add typed synthetic Studio data**

Use stable IDs `demo-project`, `chapter-1`, `chapter-2`, `chapter-3`, `section-1`, and `section-2`. Use the title `The Cartographer's Lantern`; the fiction logline “A mapmaker must redraw a city that changes each night before its last district disappears”; three chapters; two drafted sections; an approved publisher pack; one completed PDF render job; and a fully drafted book. Export `project`, `chapters`, `sectionsByChapter`, `publisherPack`, `renderJobs`, and `fullBook`, satisfying the real `Project`, `Chapter`, `Section`, `PublisherPack`, `RenderJob`, and `FullBookView` types imported from `../../apps/web/client/lib/api`.

- [ ] **Step 5: Verify and commit**

```bash
cd container/render
npm test -- remotion/demo/demo-assets.test.ts
cd ../../studio
pnpm --filter web exec tsc --noEmit
cd ..
git add container/render/remotion/demo/demo-assets.ts container/render/remotion/demo/demo-assets.test.ts studio/tests/e2e/demo-fixtures.ts
git commit -m "test: add deterministic Spooool demo fixtures"
```

## Task 3: Capture the real Studio screens with Playwright

**Files:**

- Create: `studio/tests/e2e/demo-capture.spec.ts`
- Create: `studio/scripts/capture-demo.mjs`
- Modify: `studio/package.json`
- Generate: `container/render/remotion/public/demo/screens/*.png`

- [ ] **Step 1: Write the capture test with strict route-level mocks**

Call `page.route("**/api/v1/**", handler)` before navigation. Fulfill the known GET routes below from `demo-fixtures.ts` and throw on every unrecognized endpoint so captures can never silently contact a live service:

```text
/api/v1/projects
/api/v1/projects/deleted/recent
/api/v1/blogs
/api/v1/blogs/deleted/recent
/api/v1/scripts
/api/v1/scripts/deleted/recent
/api/v1/projects/demo-project
/api/v1/projects/demo-project/outline
/api/v1/chapters/chapter-1
/api/v1/chapters/chapter-1/sections
/api/v1/projects/demo-project/book
/api/v1/projects/demo-project/publisher-pack
/api/v1/projects/demo-project/export/jobs
/api/v1/projects/demo-project/narration/auditions
/api/v1/projects/demo-project/audiobook/jobs
/api/v1/settings/elevenlabs-key
```

Use a 1440×1024 viewport, reduced motion, light color scheme, hidden caret, and `await page.evaluate(() => document.fonts.ready)`. Capture these exact states:

```ts
[
  ["/", "studio-home.png", /New book/],
  ["/compose#step-logline", "studio-compose.png", /Your story, in one sentence/],
  ["/demo-project/outline", "studio-outline.png", /3 chapters/],
  ["/demo-project/chapters/chapter-1", "studio-editor.png", /Chapter 1/],
  ["/demo-project/book", "studio-book.png", /The Cartographer's Lantern/],
  ["/demo-project#publish", "studio-publish.png", /Publisher pack/],
] as const
```

For compose, fill the real working-title input, click through the wizard, select `Fantasy`, and fill the logline. For publish, scroll the real publisher pack into view. Save screenshots to the absolute `DEMO_CAPTURE_DIR`.

- [ ] **Step 2: Add a wrapper with a deterministic local destination**

`studio/scripts/capture-demo.mjs` resolves `../../container/render/remotion/public/demo/screens`, creates it recursively, and spawns:

```text
pnpm exec playwright test tests/e2e/demo-capture.spec.ts --config tests/e2e/playwright.config.ts --workers=1
```

Pass `E2E_BASE_URL=http://localhost:4190` and the resolved `DEMO_CAPTURE_DIR`, inherit stdio, and exit with the child status. Add `"capture:demo": "node scripts/capture-demo.mjs"` to `studio/package.json`.

- [ ] **Step 3: Run capture and inspect dimensions**

```bash
cd studio
pnpm capture:demo
cd ../container/render/remotion/public/demo/screens
for image in *.png; do
  ffprobe -v error -show_entries stream=width,height -of csv=s=x:p=0 "$image"
done
```

Expected: six PNGs, each 1440×1024.

- [ ] **Step 4: Commit source and deterministic captures**

```bash
git add studio/package.json studio/scripts/capture-demo.mjs studio/tests/e2e/demo-capture.spec.ts container/render/remotion/public/demo/screens
git commit -m "feat: capture deterministic Studio demo screens"
```

## Task 4: Generate an original audio bed

**Files:**

- Create: `container/render/scripts/generate-demo-audio.mjs`
- Create: `container/render/scripts/generate-demo-audio.test.mjs`
- Modify: `container/render/package.json`
- Generate: `container/render/remotion/public/demo/audio/spooool-demo-landscape.wav`
- Generate: `container/render/remotion/public/demo/audio/spooool-demo-vertical.wav`

- [ ] **Step 1: Write failing tests for deterministic PCM and WAV headers**

Export `createDemoPcm({ durationSeconds, sampleRate, seed, cueSeconds })` and `encodeWav({ samples, sampleRate })`. Test equal inputs are byte-identical, different seeds differ, stereo sample counts equal `durationSeconds * sampleRate * 2`, bytes 0–3 spell `RIFF`, bytes 8–11 spell `WAVE`, and the data chunk matches the PCM byte length.

- [ ] **Step 2: Confirm failure**

```bash
cd container/render
npx vitest run scripts/generate-demo-audio.test.mjs
```

- [ ] **Step 3: Implement deterministic synthesis**

Use a local seeded xorshift32 generator, 48 kHz stereo signed 16-bit PCM, a warm two-note pad, restrained plucked pulses, filtered noise swells, and short tonal cues aligned to the approved scene boundaries. Apply 600 ms fade-in, 900 ms fade-out, and a peak limiter at 0.82. Use no external samples or network calls. Generate exactly 30-second and 22-second WAVs using seeds `90030` and `66030`.

- [ ] **Step 4: Add and run the generator**

Add `"generate:demo-audio": "node scripts/generate-demo-audio.mjs"`.

```bash
npm run generate:demo-audio
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 remotion/public/demo/audio/spooool-demo-landscape.wav
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 remotion/public/demo/audio/spooool-demo-vertical.wav
```

Expected: `30.000000` and `22.000000`.

- [ ] **Step 5: Commit**

```bash
git add container/render/package.json container/render/scripts/generate-demo-audio.mjs container/render/scripts/generate-demo-audio.test.mjs container/render/remotion/public/demo/audio
git commit -m "feat: generate original Spooool demo audio"
```

## Task 5: Build shared frame-driven visual primitives

**Files:**

- Create: `container/render/remotion/demo/demo-theme.ts`
- Create: `container/render/remotion/demo/demo-motion.ts`
- Create: `container/render/remotion/demo/demo-motion.test.ts`
- Create: `container/render/remotion/demo/components/DemoStage.tsx`
- Create: `container/render/remotion/demo/components/ProductFrame.tsx`
- Create: `container/render/remotion/demo/components/Headline.tsx`
- Create: `container/render/remotion/demo/components/DemoCursor.tsx`

- [ ] **Step 1: Write clamped-motion tests**

Test pure helpers `enterProgress(frame, start, duration)`, `exitProgress(frame, start, duration)`, and `sceneOpacity(frame, duration)` before, within, and after their ranges. Assert all outputs remain in `[0, 1]`, entry starts at 0 and ends at 1, exit starts at 1 and ends at 0, and the scene is fully visible through the middle.

- [ ] **Step 2: Confirm failure**

```bash
cd container/render
npm test -- remotion/demo/demo-motion.test.ts
```

- [ ] **Step 3: Implement theme and helpers**

Use `ink #171714`, `paper #F2EFE5`, `cream #E8E0CF`, `amber #D58B3D`, `sage #82937A`, and `white #FFFFFF`. Every `interpolate()` must set `extrapolateLeft: "clamp"` and `extrapolateRight: "clamp"`. Export distinct landscape and vertical safe areas.

- [ ] **Step 4: Implement reusable components**

`DemoStage` owns the full-canvas fixed-gradient paper texture, safe area, and format. `ProductFrame` renders `<Img src={staticFile(path)}>` inside fixed browser chrome and accepts only frame-derived transforms/opacity. `Headline` takes frame-derived opacity/translate. `DemoCursor` uses an inline SVG pointer with frame-derived coordinates and scale. No implementation file may contain `transition`, `animation`, `keyframes`, timers, `Date`, or `Math.random`.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- remotion/demo/demo-motion.test.ts
cd ../..
npm run lint:remotion-animation
git add container/render/remotion/demo/demo-theme.ts container/render/remotion/demo/demo-motion.ts container/render/remotion/demo/demo-motion.test.ts container/render/remotion/demo/components
git commit -m "feat: add Spooool demo motion primitives"
```

## Task 6: Compose the approved scenes independently for both formats

**Files:**

- Create: `container/render/remotion/demo/scenes/SparkScene.tsx`
- Create: `container/render/remotion/demo/scenes/ComposeScene.tsx`
- Create: `container/render/remotion/demo/scenes/ShapeScene.tsx`
- Create: `container/render/remotion/demo/scenes/RefineScene.tsx`
- Create: `container/render/remotion/demo/scenes/PublishScene.tsx`
- Create: `container/render/remotion/demo/scenes/BrandScene.tsx`
- Create: `container/render/remotion/demo/SpoooolDemo.tsx`
- Create: `container/render/remotion/demo/SpoooolDemo.test.tsx`
- Modify: `container/render/package.json`
- Modify: `container/render/package-lock.json`

- [ ] **Step 1: Write structural and approved-copy tests**

Export `DEMO_COPY` and assert:

```ts
expect(DEMO_COPY).toEqual([
  "An idea.",
  "Start with a spark.",
  "Give it shape.",
  "Make every word count.",
  "Ready when you are.",
  "Where ideas become stories.",
  "spooool.com/studio",
]);
```

Assert the scene registry has exactly `spark`, `compose`, `shape`, `refine`, `publish`, and `brand`, and that `SpoooolDemo` accepts both format values.

- [ ] **Step 2: Confirm failure**

```bash
cd container/render
npm test -- remotion/demo/SpoooolDemo.test.tsx
```

- [ ] **Step 3: Implement the six scene components**

Every scene receives `{ format, durationInFrames }`, calls `useCurrentFrame()`, and derives every visual change from the frame.

- `SparkScene`: isolated “An idea.” resolves into Studio home; book, blog, and script cards fan in.
- `ComposeScene`: real compose capture, masked title/logline focus, cursor motion, typed-line reveal, “Start with a spark.”
- `ShapeScene`: outline capture is left-aligned in landscape and upper-stacked in vertical; chapter cards travel into flow; “Give it shape.”
- `RefineScene`: editor capture is dominant; a fixed before/after excerpt wipe and assistant cue show refinement; “Make every word count.”
- `PublishScene`: book and publisher-pack captures cross-dissolve through a page mask; completed export chip appears; “Ready when you are.”
- `BrandScene`: interface recedes into a warm amber thread that draws the Spooool wordmark; tagline and URL resolve.

Landscape uses lateral composition and wider UI framing. Vertical uses stacked composition, larger typography, and specific screenshot `objectPosition`; it must never center-crop the landscape render.

- [ ] **Step 4: Assemble explicit sequence boundaries and audio**

`SpoooolDemo` maps `getDemoTimeline(format)` to:

```tsx
<Sequence
  key={scene.key}
  from={scene.from}
  durationInFrames={scene.duration}
  premountFor={30}
>
  <Scene format={format} durationInFrames={scene.duration} />
</Sequence>
```

Place the matching original WAV beneath the sequences with `<Audio src={staticFile(DEMO_ASSETS.audio[format])} />` imported from `@remotion/media`.

- [ ] **Step 5: Install the matching media package and verify**

```bash
cd container/render
npm install --save-exact @remotion/media@4.0.477
npm test -- remotion/demo
cd ../..
npm run lint:remotion-animation
rg -n "transition|animation|@keyframes|animate-|setTimeout|setInterval|Date\(|Math\.random" container/render/remotion/demo
```

Expected: tests and lint pass; source scan returns no implementation matches outside intentional negative-test strings.

- [ ] **Step 6: Commit**

```bash
git add container/render/package.json container/render/package-lock.json container/render/remotion/demo
git commit -m "feat: compose Spooool product demo scenes"
```

## Task 7: Register both compositions and expand policy coverage

**Files:**

- Modify: `container/render/remotion/Root.tsx`
- Modify: `scripts/check-remotion-animation.mjs`
- Create: `container/render/remotion/demo/registration.test.ts`

- [ ] **Step 1: Write a failing source-registration test**

Read `../Root.tsx` and assert it registers `spooool-demo-landscape` and `spooool-demo-vertical`, dimensions 1920×1080 and 1080×1920, `LANDSCAPE_DURATION` and `VERTICAL_DURATION`, and default formats `landscape` and `vertical`.

- [ ] **Step 2: Confirm failure**

```bash
cd container/render
npm test -- remotion/demo/registration.test.ts
```

- [ ] **Step 3: Register the exact compositions**

Import `SpoooolDemo`, `DEMO_FPS`, `LANDSCAPE_DURATION`, and `VERTICAL_DURATION`. Add fixed compositions with `defaultProps={{ format: "landscape" as const }}` and `defaultProps={{ format: "vertical" as const }}`.

- [ ] **Step 4: Expand policy lint**

Recursively add every `.tsx` under `container/render/remotion/demo` to the existing checker’s target list without weakening any rule.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- remotion/demo/registration.test.ts
cd ../..
npm run lint:remotion-animation
git add container/render/remotion/Root.tsx container/render/remotion/demo/registration.test.ts scripts/check-remotion-animation.mjs
git commit -m "feat: register Spooool demo compositions"
```

## Task 8: Add deterministic rendering and QA automation

**Files:**

- Create: `container/render/scripts/render-demo.mjs`
- Create: `container/render/scripts/render-demo.test.mjs`
- Modify: `container/render/package.json`
- Modify: `container/render/.gitignore`

- [ ] **Step 1: Test CLI parsing and output contracts**

Export `parseArgs(argv)` and `getRenderTargets(mode)`. Test `--stills`, `--videos`, and `--all`; reject unknown flags. Assert targets map to `spooool-demo-landscape` / `spooool-demo-vertical` and `spooool-demo-landscape.mp4` / `spooool-demo-vertical.mp4`. Assert QA frames contain every scene start and midpoint without duplicates.

- [ ] **Step 2: Confirm failure**

```bash
cd container/render
npx vitest run scripts/render-demo.test.mjs
```

- [ ] **Step 3: Implement the programmatic renderer**

Bundle `remotion/index.ts` with `@remotion/bundler`, set `publicDir` to `remotion/public`, select compositions with `@remotion/renderer`, and render:

- H.264 MP4, `yuv420p`, CRF 18, AAC audio to `artifacts/demo/*.mp4`.
- PNG stills at approved scene starts and midpoints to `artifacts/demo/stills/{format}/`.

Create output directories, default to `--all`, log exact output paths, and exit nonzero on any failure.

- [ ] **Step 4: Add scripts and ignore outputs**

```json
"render:demo": "node scripts/render-demo.mjs --all",
"render:demo:stills": "node scripts/render-demo.mjs --stills",
"render:demo:videos": "node scripts/render-demo.mjs --videos"
```

Append `artifacts/` to `container/render/.gitignore`.

- [ ] **Step 5: Test and render QA stills**

```bash
npx vitest run scripts/render-demo.test.mjs
npm run render:demo:stills
mkdir -p artifacts/demo/contact-sheets
ffmpeg -y -pattern_type glob -i 'artifacts/demo/stills/landscape/*.png' -vf 'scale=480:-1,tile=4x3' artifacts/demo/contact-sheets/landscape.png
ffmpeg -y -pattern_type glob -i 'artifacts/demo/stills/vertical/*.png' -vf 'scale=240:-1,tile=4x3' artifacts/demo/contact-sheets/vertical.png
```

Expected: stills for every scene start/midpoint and two readable contact sheets.

- [ ] **Step 6: Commit automation only**

```bash
git add container/render/package.json container/render/package-lock.json container/render/.gitignore container/render/scripts/render-demo.mjs container/render/scripts/render-demo.test.mjs
git commit -m "build: automate Spooool demo rendering"
```

## Task 9: Visually review, refine, and render final MP4s

**Files:**

- Modify as needed: `container/render/remotion/demo/**/*.tsx`
- Generate ignored: `container/render/artifacts/demo/*`

- [ ] **Step 1: Inspect both contact sheets and individual full-resolution stills**

Check text clipping, capture legibility, excessive motion, abrupt cuts, dead frames, safe areas, false feature implications, and tagline/URL hold time.

- [ ] **Step 2: Refine only frame-driven values**

Adjust scene-local frame ranges, clamped interpolation points, layout sizes, `objectPosition`, opacity, and easing. Re-render stills and contact sheets after every material pass; do not introduce time-based CSS.

- [ ] **Step 3: Render both final videos**

```bash
cd container/render
npm run render:demo:videos
```

- [ ] **Step 4: Verify media contracts**

```bash
for video in artifacts/demo/spooool-demo-landscape.mp4 artifacts/demo/spooool-demo-vertical.mp4; do
  ffprobe -v error -show_entries stream=index,codec_name,width,height,pix_fmt -show_entries format=duration -of json "$video"
done
```

Expected landscape: H.264 + AAC, 1920×1080, yuv420p, 30 seconds within one frame. Expected vertical: H.264 + AAC, 1080×1920, yuv420p, 22 seconds within one frame.

- [ ] **Step 5: Watch both videos end to end with audio**

Confirm the workflow reads without narration, cues are subtle, no frame flashes/audio clicks occur, the URL is legible, and the final resolve holds long enough to read.

- [ ] **Step 6: Commit refinements if present**

```bash
git add container/render/remotion/demo
git diff --cached --quiet || git commit -m "fix: polish Spooool demo pacing and layout"
```

## Task 10: Run full verification and merge through PR

**Files:** Verify every changed source/test/asset plus the approved spec and this plan.

- [ ] **Step 1: Run complete checks with Node 24**

```bash
export PATH=/Users/aloe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
npm run lint:remotion-animation
npm test -- --run
cd container/render
npm test
npm run build
cd ../../studio
pnpm --filter web exec tsc --noEmit
E2E_BASE_URL=http://localhost:4190 pnpm test:e2e -- demo-capture.spec.ts --workers=1
```

Expected: all checks exit 0. Baseline is 102 root test files / 1069 root tests plus 5 worker test files / 29 worker tests.

- [ ] **Step 2: Self-review coverage, placeholders, secrets, and diff hygiene**

```bash
cd ../..
rg -n "TODO|FIXME|placeholder|api[_-]?key|secret" container/render/remotion/demo container/render/scripts studio/tests/e2e/demo-* studio/scripts/capture-demo.mjs
git status --short
git diff --check origin/main...HEAD
```

Confirm the implementation covers all six approved beats, both aspect ratios, exact copy, deterministic captures, original audio, and ignored MP4s. Confirm imported/exported names and prop types match at every call site. Expected: no implementation placeholders, credentials, or whitespace errors.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin codex/spooool-demo-video
gh pr create --base main --head codex/spooool-demo-video --title "feat: add Spooool product demo videos" --body-file /tmp/spooool-demo-pr.md
```

The PR body summarizes both composition IDs, deterministic capture, original audio, ignored output locations, and exact verification results.

- [ ] **Step 4: Address CI and review until clean**

```bash
gh pr checks --watch
gh pr view --comments
gh api repos/aloewright/spooool/pulls/$(gh pr view --json number --jq .number)/reviews
```

Reproduce failures locally, add/update tests before applicable fixes, push focused commits, and repeat until all required checks pass and every actionable review comment is resolved.

- [ ] **Step 5: Merge and verify**

```bash
gh pr merge --squash --delete-branch
gh pr view --json state,mergedAt,mergeCommit,url
```

Expected: `MERGED` with a merge commit and PR URL.

- [ ] **Step 6: Deliver both local MP4s**

Provide absolute links to:

```text
/private/tmp/spooool-demo-video/container/render/artifacts/demo/spooool-demo-landscape.mp4
/private/tmp/spooool-demo-video/container/render/artifacts/demo/spooool-demo-vertical.mp4
```

Also report the merged PR URL, composition IDs, durations, and concise verification results.
