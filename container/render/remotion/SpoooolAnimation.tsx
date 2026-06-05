import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import {
  assetPathById,
  resolveAnimationProps,
  type AnimationCompositionProps,
  type AnimationProjectSpec,
} from './animation/animation-spec';
import { AnimationScene } from './animation/AnimationScene';

export const DEFAULT_ANIMATION_PROJECT: AnimationProjectSpec = {
  version: 1,
  title: 'Spooool animation',
  fps: 30,
  width: 1920,
  height: 1080,
  durationFrames: 150,
  background: { kind: 'solid', color: '#0a84ff' },
  scenes: [
    {
      id: 'scene-1',
      startFrame: 0,
      durationFrames: 150,
      layout: 'title',
      layers: [
        {
          kind: 'text',
          id: 'headline',
          startFrame: 0,
          durationFrames: 150,
          x: 160,
          y: 380,
          width: 1600,
          height: 240,
          text: 'Spooool',
          fontSize: 96,
          fontWeight: 700,
          align: 'center',
          color: '#ffffff',
          motion: [{ property: 'opacity', from: 0, to: 1, startFrame: 0, durationFrames: 30, easing: 'easeOut' }],
        },
      ],
    },
  ],
};

export function calculateAnimationDuration(project: AnimationProjectSpec): number {
  return Math.max(1, project.durationFrames);
}

export function calculateAnimationMetadata(props: unknown): {
  durationInFrames: number;
  width: number;
  height: number;
  props: AnimationCompositionProps;
} {
  const resolved = resolveAnimationProps(props);
  return {
    durationInFrames: calculateAnimationDuration(resolved.animation),
    width: resolved.animation.width,
    height: resolved.animation.height,
    props: resolved,
  };
}

export const SpoooolAnimation: React.FC<AnimationCompositionProps> = (rawProps) => {
  const { animation, assets, audio } = resolveAnimationProps(rawProps);
  const assetPaths = assetPathById(assets);
  const audioPath = audio?.r2Path;

  return (
    <AbsoluteFill>
      {audioPath ? <Audio src={staticFile(audioPath)} /> : null}
      {animation.scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
          layout="none"
        >
          <AnimationScene
            scene={scene}
            projectBackground={animation.background}
            assetPaths={assetPaths}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
