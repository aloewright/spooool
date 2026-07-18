import { describe, expect, it } from "vitest";
import { DEMO_ASSETS, getRequiredDemoAssets } from "./demo-assets";

describe("demo assets", () => {
  it("declares every approved product moment and both audio beds", () => {
    expect(DEMO_ASSETS.screens).toEqual({
      home: "demo/screens/studio-home.png",
      compose: "demo/screens/studio-compose.png",
      outline: "demo/screens/studio-outline.png",
      editor: "demo/screens/studio-editor.png",
      book: "demo/screens/studio-book.png",
      publish: "demo/screens/studio-publish.png",
    });
    expect(DEMO_ASSETS.audio).toEqual({
      landscape: "demo/audio/spooool-demo-landscape.wav",
      vertical: "demo/audio/spooool-demo-vertical.wav",
    });
    expect(new Set(getRequiredDemoAssets()).size).toBe(8);
  });
});
