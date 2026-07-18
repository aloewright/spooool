import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RENDER_ROOT = path.resolve(SCRIPT_DIR, "..");
const ARTIFACTS_DIR = path.join(RENDER_ROOT, "artifacts", "demo");

const QA_FRAMES = Object.freeze({
  landscape: Object.freeze([
    0, 45, 90, 165, 240, 330, 420, 525, 630, 705, 780, 840,
  ]),
  vertical: Object.freeze([
    0, 30, 60, 120, 180, 255, 330, 405, 480, 525, 570, 615,
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
    "-t",
    durationInSeconds.toFixed(6),
    output,
  ];
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

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    await renderDemo(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
