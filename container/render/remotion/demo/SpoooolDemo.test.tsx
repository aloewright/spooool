import { describe, expect, it } from "vitest";
import { DEMO_COPY, DEMO_SCENES, SpoooolDemo } from "./SpoooolDemo";

describe("SpoooolDemo", () => {
  it("keeps the approved product-film copy exact", () => {
    expect(DEMO_COPY).toEqual([
      "An idea.",
      "Start with a spark.",
      "Give it shape.",
      "Make every word count.",
      "Ready when you are.",
      "Where ideas become stories.",
      "spooool.com/studio",
    ]);
  });

  it("registers exactly the six approved scenes", () => {
    expect(Object.keys(DEMO_SCENES)).toEqual([
      "spark",
      "compose",
      "shape",
      "refine",
      "publish",
      "brand",
    ]);
  });

  it.each(["landscape", "vertical"] as const)(
    "accepts the %s format",
    (format) => {
      expect(SpoooolDemo({ format })).toBeTruthy();
    },
  );
});
