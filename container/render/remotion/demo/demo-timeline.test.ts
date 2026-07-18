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
