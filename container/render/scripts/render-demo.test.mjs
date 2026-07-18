import { describe, expect, it } from "vitest";
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
