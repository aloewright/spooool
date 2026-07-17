# Spooool Demo Video Design

**Status:** Approved treatment, awaiting written-spec review

**Date:** 2026-07-17

**Primary message:** “Where ideas become stories.”

## Purpose

Create a polished brand teaser that shows enough real product behavior to establish what Spooool Studio does without becoming a narrated walkthrough. The film should feel editorial, confident, and useful: a viewer sees an idea become a structured, refined, publishable story in under 30 seconds.

The deliverables are:

- a 30-second, 1920×1080 landscape master at 30 fps;
- a 22-second, 1080×1920 vertical social cut at 30 fps;
- reusable Remotion composition code and deterministic capture tooling;
- final H.264 MP4 files with an original music and sound-design mix.

## Audience and Success Criteria

The teaser is for prospective creators encountering Spooool on a website, in a launch presentation, or on social media. It succeeds when a viewer can understand, without narration, that Spooool Studio helps them:

1. begin with a rough idea;
2. choose a story format;
3. shape the idea into a logline, outline, chapters, and scenes;
4. draft and refine with editorial assistance;
5. prepare the finished work for publishing or export.

The film must remain legible without sound, show real app surfaces, avoid implying unavailable functionality, and land the line “Where ideas become stories” as the final memory.

## Creative Direction

The treatment is a hybrid product film. Real Studio screens provide credibility while Remotion supplies cinematic framing, pacing, typography, cursor guidance, and transitions.

The visual system uses Studio’s warm editorial ivory and ink as the base, soft neutral layers for depth, and Spooool blue only for focus, progress, and the final brand accent. UI screens appear as carefully cropped editorial surfaces rather than tiny full-browser screenshots. Each scene has one dominant message and one dominant interaction.

Motion is calm and precise. Screens settle with restrained position and scale changes, text enters with short opacity and vertical-offset moves, and scene changes use match cuts or masked wipes tied to lines, cards, and page edges already present in the interface. There is no bounce, decorative particle system, gratuitous 3D motion, or simulated physics.

All motion is frame-driven through Remotion. CSS transitions, CSS keyframes, Tailwind animation classes, and time-based browser animation APIs are forbidden.

## Landscape Storyboard

The landscape master runs for exactly 900 frames at 30 fps.

### Scene 1 — The spark (frames 0–89, 0–3 seconds)

A nearly blank editorial canvas holds a single blinking insertion point. The words “An idea.” appear with quiet confidence. A faint blue line begins to extend from the final period, creating the visual thread used throughout the film.

### Scene 2 — Start with a spark (frames 90–239, 3–8 seconds)

The line reveals the real Studio composer. A deterministic concept is entered, followed by a concise view of the available story formats: book, blog, and script. The active choice comes into focus while the others remain visibly available.

On-screen copy: **Start with a spark.**

### Scene 3 — Give it shape (frames 240–419, 8–14 seconds)

The entered concept match-cuts into its generated logline, then into the outline and canvas. Chapter headings and scene cards settle into a clear hierarchy. The cursor traces only the most important path so the viewer reads structure, not a dashboard.

On-screen copy: **Give it shape.**

### Scene 4 — Make every word count (frames 420–629, 14–21 seconds)

The chapter editor fills the frame. A short passage is selected, the editorial assistant opens, and a refined version replaces the selection. The change is shown as an intentional before-and-after moment rather than a dense typing sequence.

On-screen copy: **Make every word count.**

### Scene 5 — Ready when you are (frames 630–779, 21–26 seconds)

The full-work and publishing surfaces move forward in one continuous editorial gesture. Finished pages, format readiness, and export/publish controls are shown without claiming that a publication has completed.

On-screen copy: **Ready when you are.**

### Scene 6 — Brand resolve (frames 780–899, 26–30 seconds)

The product surface recedes into the warm background. The blue thread completes a subtle Spooool loop before resolving into the wordmark.

Final copy:

**Where ideas become stories.**

`spooool.com/studio`

## Vertical Storyboard

The vertical cut runs for exactly 660 frames at 30 fps. It preserves the same story while shortening holds and removing secondary UI context:

- The spark: frames 0–59;
- Start with a spark: frames 60–179;
- Give it shape: frames 180–329;
- Make every word count: frames 330–479;
- Ready when you are: frames 480–569;
- Brand resolve: frames 570–659.

The vertical version is independently composed, not center-cropped. Each app capture is reframed around one focal control or content block. Important text remains within 80 pixels of the horizontal safe area and 120 pixels of the top and bottom safe areas.

## Product Capture Strategy

A small Playwright capture workflow will render deterministic Studio states from local fixtures and route-level API mocks. It will not use a production account, production data, secrets, or network-fetched content.

The capture set will include:

- Studio home with the book, blog, and script entry points;
- the compose flow with a working title, format, and logline;
- an outline/canvas state with chapter and scene structure;
- the chapter editor with a short selected passage and assistant panel;
- the full-work or publishing surface with readiness and export controls.

Captured source frames will use a fixed desktop viewport and a fixed demo project. The script will verify every required selector before saving an image, fail when a capture is incomplete, and overwrite only the named demo assets. Personal information, real project titles, and real account identifiers are excluded.

## Remotion Architecture

The existing `container/render` Remotion project remains the source of truth. The demo will be isolated under a dedicated `remotion/demo/` module with these responsibilities:

- timeline data describing scene boundaries and copy;
- landscape and vertical composition shells;
- reusable editorial background, browser-frame, headline, cursor, and progress-thread components;
- scene components for spark, compose, structure, refinement, readiness, and end card;
- asset metadata and validation helpers;
- deterministic audio placement and mix envelopes.

`Root.tsx` will register `spooool-demo-landscape` and `spooool-demo-vertical`. Dimensions, frame rate, duration, and inline default props remain visible beside each composition registration.

Every animation uses `useCurrentFrame()`, `Sequence`, and inline `interpolate()` calls with clamped extrapolation and explicit easing. Individual `scale`, `translate`, and `rotate` style properties are preferred over composed transform strings. Rendered frames do not depend on wall-clock time, browser events, or runtime network access.

## Layout and Typography

Landscape scenes keep key readable content at least 100 pixels from the top and bottom and 120 pixels from the sides. The primary headline is at least 96 pixels, supporting copy is at least 48 pixels, and small labels are treated as visual texture unless directly called out.

Vertical scenes use a centered editorial column and reserve separate layout slots for headline, product surface, and progress thread. Readable elements stay in normal flex or grid flow; absolute positioning is reserved for backgrounds and decorative layers. Long copy is not shrunk to fit.

The type treatment should feel related to the current product rather than introducing a separate campaign identity. Local or bundled fonts are preferred so rendering remains deterministic.

## Audio Direction

The film has no narration. An original minimal electronic bed provides forward motion without becoming dominant. It is paired with restrained, locally generated sound cues for typing, selection, page movement, structural assembly, and the final brand resolve.

The audio mix will:

- remain useful when muted because all meaning is visual;
- avoid abrupt starts or stops;
- reserve the clearest transient for the final wordmark resolve;
- use only original or repository-owned assets;
- be normalized and checked for clipping before delivery.

## Asset and Output Policy

Source screenshots and audio needed for deterministic rendering live with the render project’s public assets. The two final MP4 files render to an ignored local `artifacts/` directory and are delivered to the user directly; rendered binaries are not committed unless explicitly requested.

No remote URLs are used during final rendering. Missing assets are treated as build failures rather than replaced with placeholders.

## Verification

Verification covers both code and rendered output:

- unit tests for landscape and vertical duration, scene boundaries, and required assets;
- static checks that reject CSS animation, CSS transition, and Tailwind animation patterns in Remotion code;
- TypeScript checks and the render-container test suite;
- representative still renders from the opening, compose, structure, editor, publish, and end-card scenes in both formats;
- contact sheets reviewed at normal viewing size for hierarchy, safe areas, text legibility, overlaps, and visual continuity;
- full H.264 renders for both compositions;
- `ffprobe` checks for dimensions, duration, 30 fps frame rate, H.264 video, and an audio stream;
- final playback review for pacing, audio balance, dropped frames, stale captures, and end-card readability.

## Failure Handling

The capture workflow stops on missing selectors, failed fixture responses, or incomplete images. The composition validates its required assets before render. Render or media-inspection failures block delivery. A failed vertical layout review is corrected in the vertical scene rather than hidden with cropping.

## Non-goals

- No narrated tutorial or exhaustive feature walkthrough.
- No production-user recording or production database seeding.
- No depiction of features that are only planned for a later Studio phase.
- No modification to the interactive Studio product as part of this work.
- No new video-generation backend or timeline editor feature.
- No dependence on external music, stock footage, or remote render assets.
