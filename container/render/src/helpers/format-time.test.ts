import { describe, expect, it } from "vitest";
import { formatMilliseconds } from "./format-time";

describe("formatMilliseconds", () => {
  it.each([
    [0, "00:00"],
    [61_999, "01:01"],
    [3_661_000, "01:01:01"],
  ])("formats %i milliseconds as %s", (milliseconds, expected) => {
    expect(formatMilliseconds(milliseconds)).toBe(expected);
  });
});
