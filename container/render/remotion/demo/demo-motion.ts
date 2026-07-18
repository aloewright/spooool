import { interpolate } from "remotion";

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const finiteDuration = (duration: number): number => Math.max(duration, 1);

export const toLogicalSceneFrame = (
  renderFrame: number,
  renderOffset: number,
): number => Math.max(0, renderFrame - renderOffset);

export const enterProgress = (
  frame: number,
  start: number,
  duration: number,
): number =>
  interpolate(
    frame,
    [start, start + finiteDuration(duration)],
    [0, 1],
    clamp,
  );

export const exitProgress = (
  frame: number,
  start: number,
  duration: number,
): number =>
  interpolate(
    frame,
    [start, start + finiteDuration(duration)],
    [1, 0],
    clamp,
  );

export const sceneOpacity = (
  frame: number,
  transitionInFrames: number,
): number =>
  transitionInFrames <= 0
    ? 1
    : enterProgress(frame, 0, transitionInFrames);
