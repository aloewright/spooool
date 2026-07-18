import { describe, expect, it } from "vitest";
import { DEMO_ASSETS, getRequiredDemoAssets } from "./demo-assets";

describe("demo assets", () => {
  it("declares every approved product moment and both audio beds", () => {
    expect(Object.keys(DEMO_ASSETS.screens)).toEqual([
      "home",
      "compose",
      "outline",
      "editor",
      "book",
      "publish",
    ]);
    expect(DEMO_ASSETS.audio).toEqual({
      landscape: "demo/audio/spooool-demo-landscape.wav",
      vertical: "demo/audio/spooool-demo-vertical.wav",
    });
    expect(new Set(getRequiredDemoAssets()).size).toBe(8);
  });
});
