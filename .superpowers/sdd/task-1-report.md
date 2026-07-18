# Task 1: Lock timeline contracts with tests

## Implementation

Created the shared demo timeline contract at `container/render/remotion/demo/demo-timeline.ts`:

- Defines the approved 30 FPS frame rate, with exact 900-frame landscape and 660-frame vertical durations.
- Defines immutable landscape and vertical scene maps using the approved scene order and frame boundaries.
- Exports `getDemoTimeline` and `validateDemoTimeline` for later composition and rendering tasks.
- The validator reports scene continuity, positive-duration, and final-duration violations.

## Tests and results

- `cd container/render && npm test -- remotion/demo/demo-timeline.test.ts` — passed: 1 file, 4 tests.
- `cd container/render && npm test` — passed: 8 files, 27 tests.

## TDD RED/GREEN evidence

1. RED: Added `demo-timeline.test.ts` before creating the implementation module.
2. RED verification: `npm test -- remotion/demo/demo-timeline.test.ts` failed because `./demo-timeline` could not be found. The initial invocation first reported `vitest: command not found`; after `npm ci`, it reached the expected missing-module failure.
3. GREEN: Added the minimal approved frame maps and validator in `demo-timeline.ts`.
4. GREEN verification: Focused test passed all 4 tests; the full render test suite passed all 27 tests.

## Changed files

- `container/render/remotion/demo/demo-timeline.ts`
- `container/render/remotion/demo/demo-timeline.test.ts`
- `.superpowers/sdd/task-1-report.md`

## Self-review

- Confirmed every frame value and scene key/order against the approved task brief.
- Confirmed both scene maps start at frame 0, remain contiguous, and end at their exact durations.
- Confirmed no unrelated tracked files were modified by this task.
- Confirmed `git diff --check` exits successfully.

## Concerns

None. `npm ci` emitted pre-existing dependency audit warnings (6 high-severity advisories) and pending install-script notices; neither changed source or lockfiles and neither affected the test results.

## Review follow-up: individual frame-map contracts

Review identified that continuity and total-duration assertions alone could allow an incorrect intermediate scene boundary to pass. Added explicit deep-equality assertions for the complete approved `LANDSCAPE_SCENES` and `VERTICAL_SCENES` arrays, including every `key`, `from`, and `duration` value.

### TDD evidence

This amendment only adds contract coverage for an already-correct, committed frame map, so the new assertions correctly passed on their first run; there was no production change to drive RED. The initial implementation's RED/GREEN evidence remains recorded above.

### Commands and results

```bash
cd container/render && npm test -- remotion/demo/demo-timeline.test.ts
```

Passed: 1 file, 5 tests.

```bash
cd container/render && npm test
```

Passed: 8 files, 28 tests.
