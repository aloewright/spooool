import { describe, expect, it } from "vitest";
import {
  enterProgress,
  exitProgress,
  sceneOpacity,
} from "./demo-motion";

describe("demo motion helpers", () => {
  it("clamps entry progress before, during, and after its range", () => {
    expect(enterProgress(4, 5, 10)).toBe(0);
    expect(enterProgress(5, 5, 10)).toBe(0);
    expect(enterProgress(10, 5, 10)).toBe(0.5);
    expect(enterProgress(15, 5, 10)).toBe(1);

    for (const frame of [-100, 0, 5, 10, 15, 100]) {
      expect(enterProgress(frame, 5, 10)).toBeGreaterThanOrEqual(0);
      expect(enterProgress(frame, 5, 10)).toBeLessThanOrEqual(1);
    }
  });

  it("clamps exit progress before, during, and after its range", () => {
    expect(exitProgress(4, 5, 10)).toBe(1);
    expect(exitProgress(5, 5, 10)).toBe(1);
    expect(exitProgress(10, 5, 10)).toBe(0.5);
    expect(exitProgress(15, 5, 10)).toBe(0);

    for (const frame of [-100, 0, 5, 10, 15, 100]) {
      expect(exitProgress(frame, 5, 10)).toBeGreaterThanOrEqual(0);
      expect(exitProgress(frame, 5, 10)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a scene fully visible through its middle", () => {
    expect(sceneOpacity(0, 100)).toBe(0);
    expect(sceneOpacity(15, 100)).toBe(1);
    expect(sceneOpacity(50, 100)).toBe(1);
    expect(sceneOpacity(85, 100)).toBe(1);
    expect(sceneOpacity(100, 100)).toBe(0);

    for (const frame of [-100, 0, 15, 50, 85, 100, 200]) {
      expect(sceneOpacity(frame, 100)).toBeGreaterThanOrEqual(0);
      expect(sceneOpacity(frame, 100)).toBeLessThanOrEqual(1);
    }
  });
});
