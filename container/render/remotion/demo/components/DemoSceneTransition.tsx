import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { sceneOpacity } from "../demo-motion";

type DemoSceneTransitionProps = Readonly<{
  children: ReactNode;
  transitionInFrames: number;
}>;

export const DemoSceneTransition = ({
  children,
  transitionInFrames,
}: DemoSceneTransitionProps) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{ opacity: sceneOpacity(frame, transitionInFrames) }}
    >
      {children}
    </AbsoluteFill>
  );
};
