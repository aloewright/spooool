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
    ).toEqual([
      "-i",
      "video",
      "-color_range",
      "tv",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-bsf:v",
      "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-t",
      "30.000000",
      "output.mp4",
    ]);
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

  it("accepts an encoded file only when its probed streams match the contract", () => {
    expect(renderDemoModule.assertDemoMediaProbe).toBeTypeOf("function");

    expect(() =>
      renderDemoModule.assertDemoMediaProbe(
        {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              height: 1080,
              pix_fmt: "yuv420p",
              color_range: "tv",
              color_space: "bt709",
              color_primaries: "bt709",
              color_transfer: "bt709",
              avg_frame_rate: "30/1",
              nb_read_frames: "900",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
              channel_layout: "stereo",
            },
          ],
          format: { duration: "30.016000" },
        },
        {
          width: 1920,
          height: 1080,
          fps: 30,
          frameCount: 900,
          durationInSeconds: 30,
        },
      ),
    ).not.toThrow();
  });

  it.each([
    ["pixel format", "pix_fmt", "yuv444p"],
    ["range", "color_range", "pc"],
    ["matrix", "color_space", "unknown"],
    ["primaries", "color_primaries", "unknown"],
    ["transfer", "color_transfer", "unknown"],
    ["frame count", "nb_read_frames", "899"],
  ])("rejects encoded output with invalid %s", (_label, key, value) => {
    const probe = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
          pix_fmt: "yuv420p",
          color_range: "tv",
          color_space: "bt709",
          color_primaries: "bt709",
          color_transfer: "bt709",
          avg_frame_rate: "30/1",
          nb_read_frames: "660",
          [key]: value,
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo",
        },
      ],
      format: { duration: "22.016000" },
    };

    expect(() =>
      renderDemoModule.assertDemoMediaProbe(probe, {
        width: 1080,
        height: 1920,
        fps: 30,
        frameCount: 660,
        durationInSeconds: 22,
      }),
    ).toThrow();
  });
});

describe("render-demo QA frames", () => {
  it.each([
    ["landscape", LANDSCAPE_SCENES],
    ["vertical", VERTICAL_SCENES],
  ])("contains every %s cut guard, midpoint, and end-hold frame exactly once", (format, scenes) => {
    const frames = getQaFrames(format);
    const finalFrame = scenes.at(-1).from + scenes.at(-1).duration - 1;
    const expected = [
      ...scenes.flatMap(({ from, duration }, index) => [
        from,
        from + Math.floor(duration / 2),
        ...(index === 0 ? [] : [from - 2, from - 1, from + 1]),
      ]),
      finalFrame - 1,
      finalFrame,
    ].sort((a, b) => a - b);

    expect(frames).toEqual(expected);
    expect(new Set(frames).size).toBe(frames.length);
  });
});
