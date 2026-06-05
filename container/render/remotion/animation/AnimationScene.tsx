import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import type { AnimationProjectSpec, AnimationSceneSpec } from './animation-spec';
import { AnimationLayer } from './AnimationLayer';

function backgroundStyle(bg: AnimationProjectSpec['background']): React.CSSProperties {
  if (bg.kind === 'gradient' && bg.from && bg.to) {
    const angle = bg.direction === 'horizontal' ? '90deg'
      : bg.direction === 'diagonal' ? '135deg'
        : '180deg';
    return { background: `linear-gradient(${angle}, ${bg.from}, ${bg.to})` };
  }
  return { backgroundColor: bg.color ?? '#0a84ff' };
}

function sceneBackground(
  scene: AnimationSceneSpec,
  projectBackground: AnimationProjectSpec['background'],
): React.CSSProperties {
  return backgroundStyle(scene.background ?? projectBackground);
}

function TransitionOverlay({
  transitionOut,
  sceneDuration,
}: {
  transitionOut: NonNullable<AnimationSceneSpec['transitionOut']>;
  sceneDuration: number;
}): JSX.Element | null {
  const frame = useCurrentFrame();
  if (transitionOut.kind === 'cut' || transitionOut.durationFrames <= 0) return null;

  const start = sceneDuration - transitionOut.durationFrames;
  if (frame < start) return null;

  if (transitionOut.kind === 'fade') {
    const opacity = interpolate(
      frame,
      [start, sceneDuration],
      [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
    return (
      <AbsoluteFill style={{ backgroundColor: '#000000', opacity }} />
    );
  }

  if (transitionOut.kind === 'wipe') {
    const pct = interpolate(
      frame,
      [start, sceneDuration],
      [100, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
    return (
      <AbsoluteFill style={{ clipPath: `inset(0 ${pct}% 0 0)` }} />
    );
  }

  return null;
}

export function AnimationScene({
  scene,
  projectBackground,
  assetPaths,
}: {
  scene: AnimationSceneSpec;
  projectBackground: AnimationProjectSpec['background'];
  assetPaths: Map<string, string>;
}): JSX.Element {
  return (
    <AbsoluteFill style={sceneBackground(scene, projectBackground)}>
      {scene.layers.map((layer) => {
        const assetPath = (layer.kind === 'image' || layer.kind === 'video')
          ? assetPaths.get(layer.assetId)
          : undefined;
        return (
          <Sequence
            key={layer.id}
            from={layer.startFrame}
            durationInFrames={layer.durationFrames}
            layout="none"
          >
            <AnimationLayer layer={layer} assetPath={assetPath} />
          </Sequence>
        );
      })}
      {scene.transitionOut ? (
        <TransitionOverlay
          transitionOut={scene.transitionOut}
          sceneDuration={scene.durationFrames}
        />
      ) : null}
    </AbsoluteFill>
  );
}
