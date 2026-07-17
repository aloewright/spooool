# Refined Spooool Loading Wordmark — Design Spec

## Goal

Replace the current first-visit `spooool` splash animation with a quieter, more polished brand moment. The result should feel like a premium video product: precise, typographic, confident, and fast. The complete word must remain recognizable throughout the sequence.

## Current behavior

- The splash appears only on `/`, once per browser-tab session.
- The mark is assembled from `sp` + an animated custom wave SVG + `l`.
- It runs for a fixed 3.2 seconds, then fades for 600 ms.
- A delayed `tap to enter` prompt appears at the bottom of the viewport.
- Pointer, Enter, or Space skips the splash.
- The application shell does not mount until after the splash, so boot work starts late and can visibly pop in after the overlay fades.

The custom wave and bouncy scale entrance read as playful and hand-drawn. The word itself is temporarily abstracted, and the long fixed delay makes the transition feel more like an intro screen than a refined loading state.

## Approved direction to implement: “Rolling O”

Set the entire lowercase word `spooool` in the existing Nunito brand family at a deliberate, heavy-but-not-black weight. Each character is a real text glyph; no letter is replaced by an illustration.

The four `o` glyphs create the signature motion:

1. The word enters as one quiet unit with a short opacity rise and a 4 px upward settle.
2. A narrow emphasis travels left-to-right across the four `o` glyphs. Each `o` briefly compresses horizontally and expands vertically by only a few percent, then returns to its exact resting shape. The stagger suggests film moving across rollers without literally drawing film or a spool.
3. As the last `o` settles, the whole word reaches full contrast and holds briefly.
4. The overlay dissolves cleanly into the application with no exit scaling.

The motion should be visible but subtle: no bounce, rotation, elastic overshoot, glow, blur, rainbow color, per-letter vertical hopping, or decorative particles.

## Visual system

- Background: the exact existing `--background` token, in both light and dark themes.
- Wordmark: the exact existing `--foreground` token.
- Secondary/loading phase: use foreground opacity only; do not introduce a new accent color.
- Typeface: `Nunito`, using the repo's local variable font.
- Weight: approximately 760, optically checked in-browser.
- Size: `clamp(56px, 10vw, 128px)`; smaller and calmer than the current maximum.
- Tracking: slightly tight, approximately `-0.045em`, adjusted so the repeated `o` sequence reads as one word without touching.
- Layout: optically centered in the viewport. No card, shadow, border, progress bar, or surrounding ornament.
- Copy: only `spooool`. Remove `tap to enter`.

## Timing and interaction

- Entrance: 240 ms.
- Rolling `o` sequence: four 180 ms pulses, staggered by 90 ms.
- Rest/hold: enough for a total minimum presentation of approximately 1.35 seconds.
- Exit dissolve: 280 ms.
- Maximum presentation: preserve a bounded fallback so a failed event cannot trap the user.
- Skip: pointer click, Enter, Space, or Escape starts the exit immediately.
- Session behavior: retain once-per-tab behavior on the home route.
- Boot behavior: mount the real application beneath the overlay immediately so auth and home requests begin during the brand moment. Keep the covered shell inert and `aria-hidden` until dismissal.
- Storage behavior: a denied or unavailable `sessionStorage` must never crash or trap the application; dismissal always wins.

This remains a branded first-visit splash, not a determinate progress indicator. The implementation must not claim to represent network progress. Route-level loading states remain separate and are not changed by this feature.

## Component structure

- Extract the splash and animated wordmark from `App.tsx` into focused components under `src/frontend/components/`.
- Render the word as seven individually addressable character spans while preserving a single accessible name of `spooool`.
- Use shared CSS classes and custom properties for letter index/stagger; avoid duplicated one-off rules for each `o` where possible.
- Keep the splash state machine explicit (`entering` → `holding` → `leaving`) so timing and skip behavior are testable.
- Do not add an animation dependency for this small motion system.

## Accessibility

- The overlay has an accessible name of `spooool` and does not announce seven separate letters.
- Keyboard skip supports Enter, Space, and Escape with visible focus treatment if focus is shown.
- Under `prefers-reduced-motion: reduce`, show the settled wordmark without letter deformation, keep only a brief opacity transition, and never enforce the full animated hold.
- The word remains readable at every animated frame; transforms never remove glyphs or reduce text contrast.

## Responsive behavior

- Verify at a compact mobile viewport and a desktop viewport.
- Respect safe-area insets without shifting the optical center unnecessarily.
- No wrapping, clipping, or horizontal overflow at 320 px width.
- Use dynamic viewport units for the overlay.

## Verification and tests

- DOM tests for the accessible word, character structure, session gating, automatic exit, and pointer/keyboard skip.
- Reduced-motion test or deterministic class/state assertion.
- Confirm the application mounts beneath the overlay, becomes interactive after exit, and the splash does not reappear within the same tab session.
- Browser visual verification in light and dark themes at desktop and mobile sizes.
- Capture the settled state and at least one mid-sequence state for visual inspection.
- Run the relevant Vitest suite, lint, and type checks.

## Out of scope

- Replacing every `Loading…` message or the smaller prompt-to-video spinner.
- Changing the persistent header wordmark.
- Adding a real application boot-progress model.
- Changing home-page layout, navigation, or theme tokens.
