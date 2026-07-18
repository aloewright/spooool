import { describe, expect, it } from "vitest";
import * as renderDemoModule from "./render-demo.mjs";
import {
  getQaFrames,
  getRenderTargets,
  parseArgs,
} from "./render-demo.mjs";
import {
  LANDSCAPE_SCENES,
  VERTICAL_SCENES,
} from "../remotion/demo/demo-timeline";

describe("render-demo CLI", () => {
  it.each([
    [[], "all"],
    [["--all"], "all"],
    [["--stills"], "stills"],
    [["--videos"], "videos"],
  ])("parses %j as %s", (argv, expected) => {
    expect(parseArgs(argv)).toBe(expected);
  });

  it.each([["--wat"], ["--all", "--videos"]])(
    "rejects unsupported argument combinations",
    (...argv) => {
      expect(() => parseArgs(argv)).toThrow(/usage/i);
    },
  );
});

describe("render-demo targets", () => {
  it("maps both formats to the registered composition IDs and MP4 names", () => {
    const targets = getRenderTargets("all");

    expect(
      targets.map(({ format, compositionId, videoFileName }) => ({
        format,
        compositionId,
        videoFileName,
      })),
    ).toEqual([
      {
        format: "landscape",
        compositionId: "spooool-demo-landscape",
        videoFileName: "spooool-demo-landscape.mp4",
      },
      {
        format: "vertical",
        compositionId: "spooool-demo-vertical",
        videoFileName: "spooool-demo-vertical.mp4",
      },
    ]);
  });

  it.each([
    ["stills", true, false],
    ["videos", false, true],
    ["all", true, true],
  ])("enables the expected outputs for %s", (mode, renderStills, renderVideo) => {
    expect(getRenderTargets(mode)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ renderStills, renderVideo }),
      ]),
    );
  });
});

describe("render-demo media contract", () => {
  it("caps the stitcher at the composition duration", () => {
    expect(renderDemoModule.enforceDemoDuration).toBeTypeOf("function");

    expect(
      renderDemoModule.enforceDemoDuration(
        { type: "pre-stitcher", args: ["-i", "audio.wav", "audio.aac"] },
        30,
      ),
    ).toEqual(["-i", "audio.wav", "audio.aac"]);
    expect(
      renderDemoModule.enforceDemoDuration(
        { type: "stitcher", args: ["-i", "video", "output.mp4"] },
        30,
      ),
    ).toEqual(["-i", "video", "-t", "30.000000", "output.mp4"]);
  });

  it("renders PNG frames into limited-range BT.709 yuv420p", () => {
    expect(renderDemoModule.DEMO_VIDEO_RENDER_OPTIONS).toEqual({
      codec: "h264",
      imageFormat: "png",
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      crf: 18,
      audioCodec: "aac",
    });
  });
});

describe("render-demo QA frames", () => {
  it.each([
    ["landscape", LANDSCAPE_SCENES],
    ["vertical", VERTICAL_SCENES],
  ])("contains every %s scene start and midpoint exactly once", (format, scenes) => {
    const frames = getQaFrames(format);
    const expected = scenes.flatMap(({ from, duration }) => [
      from,
      from + Math.floor(duration / 2),
    ]);

    expect(frames).toEqual(expected);
    expect(new Set(frames).size).toBe(frames.length);
  });
});
