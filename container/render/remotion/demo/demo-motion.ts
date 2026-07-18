import { interpolate } from "remotion";

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const finiteDuration = (duration: number): number => Math.max(duration, 1);

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

export const sceneOpacity = (frame: number, duration: number): number => {
  const fadeDuration = Math.min(15, finiteDuration(duration) / 2);

  return Math.min(
    enterProgress(frame, 0, fadeDuration),
    exitProgress(frame, finiteDuration(duration) - fadeDuration, fadeDuration),
  );
};
