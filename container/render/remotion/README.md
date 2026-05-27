# Remotion compositions

Ported from [remotion-dev/recorder](https://github.com/remotion-dev/recorder)
at commit `4221b1f3dd4ec8b115b0b71c27011ee565213bfa`.

## What was copied

`remotion/` and `config/` from the upstream repo were copied verbatim into
`container/render/remotion/` and `container/render/config/` respectively.

## What was changed

- `Root.tsx` — added the `spooool-video` composition (registered first) using
  `SpoooolVideo.tsx` as its component. Upstream compositions (`welcome`,
  `record`, `empty`) are kept intact and registered after.
- `SpoooolVideo.tsx` — new file (not from upstream). This is the primary
  composition used by the headless render harness.

## Removed

Nothing was removed. The upstream's user-facing config screens (`GoToRecorder`,
caption editor overlay, drag-drop b-roll, action overlays) are part of the
existing component tree and are only activated in the Remotion Studio environment
(`env.isStudio`). They are harmless in headless renders — they either check
`isStudio` before rendering or export passive utilities (React refs, layout
constants). Full trimming of studio-only code is a future cleanup pass.

## Input props shape for `spooool-video`

```ts
{
  takes: string[];          // staticFile-relative paths to take video files
  title?: string;           // optional title overlay on first take
  brand?: {
    color?: string;         // accent hex colour (default "#0a84ff")
    logoUrl?: string;       // optional logo image URL
  };
  sceneOrder?: string[];    // placeholder — wired in Task 12
  layouts?: Record<string, unknown>; // placeholder — wired in Task 12
}
```

`durationInFrames` is computed as `takes.length * 300` (10 s per take at 30 fps)
until Task 12 wires actual per-take durations via `calculateMetadata`.

## Added npm dependencies

These packages were added to `container/render/package.json`:

- `@remotion/animation-utils`
- `@remotion/captions`
- `@remotion/google-fonts`
- `@remotion/layout-utils`
- `@remotion/media-utils`
- `@remotion/shapes`
- `@remotion/studio`
- `@remotion/zod-types`
- `react` + `@types/react`
- `zod`

## Upstream license

remotion-dev/recorder is MIT licensed.
