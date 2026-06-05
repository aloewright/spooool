import { Easing, interpolate, spring } from 'remotion';
import type { FrameDrivenMotionSpec } from './animation-spec';

export function motionValue(spec: FrameDrivenMotionSpec, frame: number, fps: number): number {
  const relative = frame - spec.startFrame;
  if (spec.easing === 'spring') {
    return spring({ frame: relative, fps, from: spec.from, to: spec.to, durationInFrames: spec.durationFrames });
  }
  const easing = spec.easing === 'easeOut'
    ? Easing.out(Easing.cubic)
    : spec.easing === 'easeInOut'
      ? Easing.inOut(Easing.cubic)
      : Easing.linear;
  return interpolate(frame, [spec.startFrame, spec.startFrame + spec.durationFrames], [spec.from, spec.to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}
