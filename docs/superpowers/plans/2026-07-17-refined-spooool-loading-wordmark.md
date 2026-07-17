# Refined Spooool Loading Wordmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking first-visit SVG splash with the approved fast, accessible “Rolling O” Nunito wordmark while the real home application boots underneath it.

**Architecture:** A focused `BrandSplash` module owns the explicit `entering → holding → leaving` state machine, reduced-motion timing, safe session gate, and seven-glyph wordmark. `App` always mounts its shell and renders the splash as a sibling overlay, marking the covered shell inert and hidden from assistive technology until dismissal. Strand CSS supplies the token-locked typography and motion without a new dependency.

**Tech Stack:** React 18, TypeScript, Vitest + happy-dom, Vite, Strand CSS tokens, Playwright/browser QA.

**Required animation guidance:** Use the `$motion` skill's CSS/React best practices for this micro-interaction. Keep the animation compositor-friendly with `transform` and `opacity`, use CSS animation rather than adding Motion/Remotion, avoid overshoot for this professional product surface, and do not add permanent `will-change` because CSS animations are promoted automatically.

## Global Constraints

- The visible copy is exactly `spooool`; remove `tap to enter`.
- Use the local `Nunito` variable font at approximately weight 760, `clamp(56px, 10vw, 128px)`, and approximately `-0.045em` tracking.
- Use only the existing `--background` and `--foreground` tokens plus foreground opacity; no accent color, card, border, shadow, glow, blur, particles, or progress claim.
- Entrance is 240 ms; each of four `o` pulses is 180 ms with 90 ms stagger; automatic leave begins at approximately 1.35 seconds; exit dissolve is 280 ms.
- Motion is a few-percent horizontal compression and vertical expansion only; no bounce, rotation, elastic overshoot, vertical hopping, or exit scaling.
- Pointer, Enter, Space, and Escape skip immediately; focus-visible treatment is required.
- Reduced motion shows the settled word without deformation and dismisses promptly without the full hold.
- Preserve home-only, once-per-tab behavior and ensure denied `sessionStorage` cannot crash or trap the app.
- Mount the application beneath the overlay immediately and keep it inert plus `aria-hidden` only while covered.
- Preserve bare `/embed/*` rendering and the non-refreshing `/studio` fallback.
- No dependency or lockfile changes.
- Follow `$motion` guidance: CSS `transform`/`opacity` only for animated properties, no `translateZ(0)`, no permanent `will-change`, and no spring overshoot.

---

### Task 1: Build the tested brand-splash state machine

**Files:**
- Create: `src/frontend/components/BrandSplash.tsx`
- Create: `src/frontend/components/BrandSplash.dom.test.tsx`

**Interfaces:**
- Consumes: `window.matchMedia`, `window.sessionStorage`, React timers and effects.
- Produces: `BrandSplash({ onDone }: { onDone: () => void })`, `useBrandSplash(pathname: string): { show: boolean; dismiss: () => void }`, and exported timing constants for deterministic tests.

- [ ] **Step 1: Write failing DOM tests for the public behavior**

Create happy-dom tests that mount the real component and assert: a single button named `spooool`; seven `.splash__letter` spans containing `s`, `p`, four `o` glyphs, and `l`; four o-index custom properties; `entering`, `holding`, and `leaving` transitions under fake timers; automatic `onDone`; click, Enter, Space, and Escape skip; reduced motion starts settled and leaves on its shorter schedule; and duplicate skip events still call `onDone` once. Add a small hook harness that asserts non-home paths never show, a first home visit does show and writes `splash:seen`, dismissal succeeds when storage throws, and a second home mount in the same tab stays hidden.

- [ ] **Step 2: Run the test and verify RED**

Run:
```bash
NODE_OPTIONS=--localstorage-file=/private/tmp/spooool-vitest-localstorage npx vitest run src/frontend/components/BrandSplash.dom.test.tsx
```
Expected: FAIL because `./BrandSplash` does not exist.

- [ ] **Step 3: Implement the minimal focused module**

Implement an explicit phase union and timer table. Render a native full-screen button with `type="button"`, `aria-label="spooool"`, `data-phase`, and `data-reduced-motion`; render seven child spans hidden from the accessibility tree, assigning `--splash-o-index` through a typed CSS custom-property style. Keep the button in the natural tab order so first paint remains visually clean, and support Escape at the window level so dismissal does not depend on focus. Use one idempotent finish callback and a bounded fallback timer. Detect reduced motion synchronously with a guarded `matchMedia` read. In the session hook, read and write `splash:seen` inside `try/catch`, mark the splash seen when it is shown to prevent reload loops, and always update React state even if storage throws.

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command. Expected: all new tests PASS with no warnings or stderr.

- [ ] **Step 5: Commit the self-contained component task**

```bash
git add src/frontend/components/BrandSplash.tsx src/frontend/components/BrandSplash.dom.test.tsx
git commit -m "feat: add polished loading wordmark state machine"
```

### Task 2: Mount the application beneath the overlay

**Files:**
- Modify: `src/frontend/App.tsx`
- Create: `src/frontend/App.splash.dom.test.tsx`

**Interfaces:**
- Consumes: `BrandSplash` and `useBrandSplash` from Task 1.
- Produces: an always-mounted `.app-shell` plus an optional sibling `.splash`; the shell has `inert=""` and `aria-hidden="true"` exactly while the splash covers it.

- [ ] **Step 1: Write the failing App integration test**

Mount the real `App` at `/` with an empty tab session and stub only external `fetch`/`matchMedia`. Assert that `.app-shell` and the named splash button exist simultaneously, the shell is inert and aria-hidden while covered, advancing the exit timers removes the splash and both attributes, `sessionStorage['splash:seen']` is `1`, and a remount in the same tab skips the splash. Keep a regression case proving `/studio` and `/embed/:id` do not gain a splash.

- [ ] **Step 2: Run the test and verify RED**

Run:
```bash
NODE_OPTIONS=--localstorage-file=/private/tmp/spooool-vitest-localstorage npx vitest run src/frontend/App.splash.dom.test.tsx
```
Expected: FAIL because the current `App` returns only the old splash and does not mount `.app-shell` underneath it.

- [ ] **Step 3: Integrate the new module at the app-shell boundary**

Delete `SpoolWave`, the old inline `Splash`, their fixed timing constants, and the old `useSplash`. Import the Task 1 exports, call `useBrandSplash(location.pathname)`, keep the `/embed/*` early return unchanged, always render the main app shell, spread a typed `{ inert: '', 'aria-hidden': true }` attribute object only while covered, and render `<BrandSplash onDone={splash.dismiss} />` after the shell. Do not change routes, header, footer, or route fallbacks.

- [ ] **Step 4: Run focused and shell regression tests**

Run:
```bash
NODE_OPTIONS=--localstorage-file=/private/tmp/spooool-vitest-localstorage npx vitest run src/frontend/App.splash.dom.test.tsx src/frontend/App.shell.dom.test.tsx
```
Expected: both files PASS; any pre-existing sandbox network diagnostic is recorded separately from assertion results.

- [ ] **Step 5: Commit the integration task**

```bash
git add src/frontend/App.tsx src/frontend/App.splash.dom.test.tsx
git commit -m "fix: boot the app beneath the brand splash"
```

### Task 3: Apply the approved visual system and verify it

**Files:**
- Modify: `src/frontend/styles/strand.css`
- Modify: `docs/superpowers/specs/2026-07-17-refined-spooool-loading-wordmark-design.md`

**Interfaces:**
- Consumes: Task 1 class names, phase attributes, o-index custom property, and the existing Strand theme tokens.
- Produces: responsive light/dark/reduced-motion presentation at desktop and 320 px mobile widths.

- [ ] **Step 1: Replace the obsolete wave/splash CSS**

Remove `.spooool-wave`, `.spooool-wave--paced`, the wave keyframes, Caveat styling, delayed hint, scale entrance, and six-second motion. Style `.splash` as a reset full-viewport button using `100dvh`, safe-area padding, token background/foreground, and a layer above the app's fixed dialogs. Style `.splash__word` with a compact focus-visible outline plus the exact approved Nunito size/weight/tracking and a 4 px opacity/translate entrance. Animate `.splash__letter--o` through `scaleX`/`scaleY` using `calc(var(--splash-o-index) * 90ms)` and shared keyframes. Fade only the overlay during `leaving`. In reduced motion, disable all glyph deformation, show a settled mark, and use only the brief opacity dissolve.

- [ ] **Step 2: Run static verification**

Run:
```bash
npm run lint
npm run type-check
npm run build
```
Expected: all commands exit 0; no dependency or lockfile diff.

- [ ] **Step 3: Verify visually and interactively in Chromium**

Start `npm run dev:frontend -- --host 127.0.0.1 --strictPort` with the required sandbox approval. In the built-in browser first, inspect light and dark desktop plus 320 px mobile, capture a mid-sequence and settled state, verify the exact one-word copy, typography, token colors, no clipping/overflow, no app pop-in after dissolve, focus-visible keyboard skip, pointer skip, Escape, reduced-motion prompt dismissal, and no repeat after reload. If the built-in browser is unavailable, use installed Playwright Chromium and record that fallback.

Also perform a `$motion` code audit: confirm every animated property is `transform` or `opacity`, the serious product motion has no overshoot, CSS animation does not carry a redundant permanent `will-change`, and no per-frame React work or layout-triggering property was introduced.

- [ ] **Step 4: Run the full root verification gate**

Run:
```bash
NODE_OPTIONS=--localstorage-file=/private/tmp/spooool-vitest-localstorage npm test
npm run lint
npm run type-check
npm run build
git diff --exit-code -- package-lock.json
```
Expected: test assertions pass, lint/type-check/build exit 0, and the lockfile has no diff. Record any known pre-existing test-runner stderr separately.

- [ ] **Step 5: Commit docs and styling**

```bash
git add src/frontend/styles/strand.css docs/superpowers/specs/2026-07-17-refined-spooool-loading-wordmark-design.md docs/superpowers/plans/2026-07-17-refined-spooool-loading-wordmark.md
git commit -m "style: refine the spooool loading wordmark"
```

### Task 4: Review and ship

**Files:**
- Review only: branch diff against `origin/main`

**Interfaces:**
- Consumes: Tasks 1–3 and their verification evidence.
- Produces: reviewed, passing pull request merged into `main` without unrelated editor changes.

- [ ] **Step 1: Request task and whole-branch review**

Generate review packages from each recorded base SHA and from `git merge-base origin/main HEAD`; dispatch independent spec/code-quality review. Fix every Critical or Important finding with focused regression tests, then re-review.

- [ ] **Step 2: Push and open a focused pull request**

Push `codex/polish-loading-animation`, open a PR describing the root cause, Rolling O solution, accessibility/session behavior, and visual/test evidence, and confirm the diff excludes `studio/**`, `.pnpm-store`, and dependency files.

- [ ] **Step 3: Resolve CI and review feedback, then merge**

Wait for all checks and review comments, address failures or actionable comments, rerun the affected local gates, and merge only when the PR is green. Confirm the merge commit is present on `origin/main`.
