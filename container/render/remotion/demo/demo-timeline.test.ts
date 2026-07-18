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

  it("uses the approved landscape scene map", () => {
    expect(LANDSCAPE_SCENES).toEqual([
      { key: "spark", from: 0, duration: 90 },
      { key: "compose", from: 90, duration: 150 },
      { key: "shape", from: 240, duration: 180 },
      { key: "refine", from: 420, duration: 210 },
      { key: "publish", from: 630, duration: 150 },
      { key: "brand", from: 780, duration: 120 },
    ]);
  });

  it("uses the approved vertical scene map", () => {
    expect(VERTICAL_SCENES).toEqual([
      { key: "spark", from: 0, duration: 60 },
      { key: "compose", from: 60, duration: 120 },
      { key: "shape", from: 180, duration: 150 },
      { key: "refine", from: 330, duration: 150 },
      { key: "publish", from: 480, duration: 90 },
      { key: "brand", from: 570, duration: 90 },
    ]);
  });
});
