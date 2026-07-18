import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { isMainModule } from "./is-main-module.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_ROOT = path.resolve(SCRIPT_DIR, "..");
const ARTIFACTS_DIR = path.join(RENDER_ROOT, "artifacts", "demo");
const execFileAsync = promisify(execFile);

const QA_FRAMES = Object.freeze({
  landscape: Object.freeze([
    0, 45, 88, 89, 90, 91, 165, 238, 239, 240, 241, 330, 418, 419,
    420, 421, 525, 628, 629, 630, 631, 705, 778, 779, 780, 781, 840,
    898, 899,
  ]),
  vertical: Object.freeze([
    0, 30, 58, 59, 60, 61, 120, 178, 179, 180, 181, 255, 328, 329,
    330, 331, 405, 478, 479, 480, 481, 525, 568, 569, 570, 571, 615,
    658, 659,
  ]),
});

const TARGETS = Object.freeze([
  Object.freeze({
    format: "landscape",
    compositionId: "spooool-demo-landscape",
    videoFileName: "spooool-demo-landscape.mp4",
  }),
  Object.freeze({
    format: "vertical",
    compositionId: "spooool-demo-vertical",
    videoFileName: "spooool-demo-vertical.mp4",
  }),
]);

export const DEMO_VIDEO_RENDER_OPTIONS = Object.freeze({
  codec: "h264",
  imageFormat: "png",
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  crf: 18,
  audioCodec: "aac",
});

export const DEMO_H264_VUI_BSF =
  "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1";

const USAGE = "Usage: node scripts/render-demo.mjs [--all|--stills|--videos]";

export const parseArgs = (argv) => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--all")) {
    return "all";
  }
  if (argv.length === 1 && argv[0] === "--stills") {
    return "stills";
  }
  if (argv.length === 1 && argv[0] === "--videos") {
    return "videos";
  }

  throw new Error(USAGE);
};

export const getQaFrames = (format) => {
  const frames = QA_FRAMES[format];
  if (!frames) {
    throw new Error(`Unknown demo format: ${format}`);
  }

  return [...frames];
};

export const getRenderTargets = (mode) => {
  if (!new Set(["all", "stills", "videos"]).has(mode)) {
    throw new Error(`Unknown render mode: ${mode}`);
  }

  return TARGETS.map((target) => ({
    ...target,
    renderStills: mode === "all" || mode === "stills",
    renderVideo: mode === "all" || mode === "videos",
  }));
};

export const enforceDemoDuration = ({ type, args }, durationInSeconds) => {
  if (type !== "stitcher") {
    return args;
  }

  const output = args.at(-1);
  if (!output) {
    throw new Error("FFmpeg stitcher command is missing its output path");
  }

  return [
    ...args.slice(0, -1),
    "-color_range",
    "tv",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-bsf:v",
    DEMO_H264_VUI_BSF,
    "-t",
    durationInSeconds.toFixed(6),
    output,
  ];
};

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
};

export const assertDemoMediaProbe = (probe, expected) => {
  const video = probe.streams?.find(({ codec_type }) => codec_type === "video");
  const audio = probe.streams?.find(({ codec_type }) => codec_type === "audio");
  if (!video || !audio) {
    throw new Error("Demo output must contain both video and audio streams");
  }

  assertEqual(video.codec_name, "h264", "video codec");
  assertEqual(video.width, expected.width, "video width");
  assertEqual(video.height, expected.height, "video height");
  assertEqual(video.pix_fmt, "yuv420p", "pixel format");
  assertEqual(video.color_range, "tv", "color range");
  assertEqual(video.color_space, "bt709", "matrix coefficients");
  assertEqual(video.color_primaries, "bt709", "color primaries");
  assertEqual(video.color_transfer, "bt709", "transfer characteristics");
  assertEqual(video.avg_frame_rate, `${expected.fps}/1`, "frame rate");
  assertEqual(
    Number(video.nb_read_frames ?? video.nb_frames),
    expected.frameCount,
    "video frame count",
  );

  assertEqual(audio.codec_name, "aac", "audio codec");
  assertEqual(audio.sample_rate, "48000", "audio sample rate");
  assertEqual(audio.channels, 2, "audio channel count");
  assertEqual(audio.channel_layout, "stereo", "audio channel layout");

  const duration = Number(probe.format?.duration);
  const tolerance = 1 / expected.fps;
  if (
    !Number.isFinite(duration) ||
    Math.abs(duration - expected.durationInSeconds) > tolerance
  ) {
    throw new Error(
      `container duration: expected ${expected.durationInSeconds}s within ${tolerance}s, received ${duration}s`,
    );
  }
};

export const probeDemoMedia = async (filePath) => {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,avg_frame_rate,nb_frames,nb_read_frames,sample_rate,channels,channel_layout:format=duration",
    "-of",
    "json",
    filePath,
  ]);

  return JSON.parse(stdout);
};

export const verifyDemoMedia = async (filePath, expected) => {
  const probe = await probeDemoMedia(filePath);
  assertDemoMediaProbe(probe, expected);
  return probe;
};

const ensureOutputDirectories = async (targets) => {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await Promise.all(
    targets
      .filter(({ renderStills }) => renderStills)
      .map(({ format }) =>
        mkdir(path.join(ARTIFACTS_DIR, "stills", format), {
          recursive: true,
        }),
      ),
  );
};

const renderTarget = async ({
  composition,
  serveUrl,
  target,
}) => {
  if (target.renderStills) {
    for (const frame of getQaFrames(target.format)) {
      const output = path.join(
        ARTIFACTS_DIR,
        "stills",
        target.format,
        `frame-${String(frame).padStart(4, "0")}.png`,
      );
      console.log(`Rendering ${output}`);
      await renderStill({
        composition,
        serveUrl,
        frame,
        imageFormat: "png",
        output,
        overwrite: true,
        isProduction: true,
      });
      console.log(`Rendered ${output}`);
    }
  }

  if (target.renderVideo) {
    const outputLocation = path.join(ARTIFACTS_DIR, target.videoFileName);
    console.log(`Rendering ${outputLocation}`);
    await renderMedia({
      composition,
      serveUrl,
      outputLocation,
      ...DEMO_VIDEO_RENDER_OPTIONS,
      ffmpegOverride: (info) =>
        enforceDemoDuration(
          info,
          composition.durationInFrames / composition.fps,
        ),
      overwrite: true,
      isProduction: true,
    });
    await verifyDemoMedia(outputLocation, {
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      frameCount: composition.durationInFrames,
      durationInSeconds: composition.durationInFrames / composition.fps,
    });
    console.log(`Rendered ${outputLocation}`);
  }
};

export const renderDemo = async (mode) => {
  const targets = getRenderTargets(mode);
  await ensureOutputDirectories(targets);

  const entryPoint = path.join(RENDER_ROOT, "remotion", "index.ts");
  const publicDir = path.join(RENDER_ROOT, "remotion", "public");
  console.log(`Bundling ${entryPoint} with publicDir ${publicDir}`);
  const serveUrl = await bundle({ entryPoint, publicDir });

  for (const target of targets) {
    const composition = await selectComposition({
      serveUrl,
      id: target.compositionId,
    });
    await renderTarget({ composition, serveUrl, target });
  }
};

if (isMainModule({ argvPath: process.argv[1], moduleUrl: import.meta.url })) {
  try {
    await renderDemo(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
