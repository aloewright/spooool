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

  it("keeps a scene root opaque after its incoming overlap", () => {
    expect(sceneOpacity(0, 0)).toBe(1);
    expect(sceneOpacity(0, 15)).toBe(0);
    expect(sceneOpacity(7.5, 15)).toBe(0.5);
    expect(sceneOpacity(15, 15)).toBe(1);
    expect(sceneOpacity(100, 15)).toBe(1);

    for (const frame of [-100, 0, 7.5, 15, 100]) {
      expect(sceneOpacity(frame, 15)).toBeGreaterThanOrEqual(0);
      expect(sceneOpacity(frame, 15)).toBeLessThanOrEqual(1);
    }
  });
});
