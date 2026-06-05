import React from 'react';
import { Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { AnimationLayerSpec } from './animation-spec';
import { motionValue } from './motion';

type LayerStyle = {
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
  transform: string;
  zIndex: number;
};

function styleForLayer(layer: AnimationLayerSpec, frame: number, fps: number): LayerStyle {
  let x = layer.x;
  let y = layer.y;
  let scale = 1;
  let rotate = 0;
  let opacity = layer.opacity ?? 1;

  for (const motion of layer.motion ?? []) {
    const value = motionValue(motion, frame, fps);
    if (motion.property === 'x') x = value;
    if (motion.property === 'y') y = value;
    if (motion.property === 'scale') scale = value;
    if (motion.property === 'rotate') rotate = value;
    if (motion.property === 'opacity') opacity = value;
  }

  return {
    left: x,
    top: y,
    width: layer.width,
    height: layer.height,
    opacity,
    transform: `scale(${scale}) rotate(${rotate}deg)`,
    zIndex: layer.zIndex ?? 0,
  };
}

const boxStyle = (style: LayerStyle): React.CSSProperties => ({
  position: 'absolute',
  left: style.left,
  top: style.top,
  width: style.width,
  height: style.height,
  opacity: style.opacity,
  transform: style.transform,
  zIndex: style.zIndex,
});

export function AnimationLayer({
  layer,
  assetPath,
}: {
  layer: AnimationLayerSpec;
  assetPath?: string;
}): JSX.Element | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = styleForLayer(layer, frame, fps);

  if (layer.kind === 'text') {
    return (
      <div
        style={{
          ...boxStyle(style),
          color: layer.color,
          fontSize: layer.fontSize,
          fontWeight: layer.fontWeight,
          textAlign: layer.align,
          display: 'flex',
          alignItems: 'center',
          fontFamily: 'Inter, system-ui, sans-serif',
          lineHeight: 1.1,
        }}
      >
        {layer.text}
      </div>
    );
  }

  if (layer.kind === 'shape') {
    const shapeStyle: React.CSSProperties = {
      ...boxStyle(style),
      backgroundColor: layer.fill,
      border: layer.stroke ? `${layer.strokeWidth ?? 2}px solid ${layer.stroke}` : undefined,
      borderRadius: layer.shape === 'circle'
        ? '50%'
        : layer.shape === 'roundRect'
          ? layer.radius ?? 16
          : 0,
    };
    if (layer.shape === 'line') {
      shapeStyle.height = layer.strokeWidth ?? 2;
      shapeStyle.backgroundColor = layer.stroke ?? layer.fill;
    }
    return <div style={shapeStyle} />;
  }

  if (layer.kind === 'image' && assetPath) {
    return (
      <div style={{ ...boxStyle(style), overflow: 'hidden' }}>
        <Img
          src={staticFile(assetPath)}
          style={{ width: '100%', height: '100%', objectFit: layer.fit }}
        />
      </div>
    );
  }

  if (layer.kind === 'video' && assetPath) {
    return (
      <div style={{ ...boxStyle(style), overflow: 'hidden' }}>
        <OffthreadVideo
          src={staticFile(assetPath)}
          startFrom={layer.trimBeforeFrames ?? 0}
          volume={layer.volume ?? 0}
          style={{ width: '100%', height: '100%', objectFit: layer.fit }}
        />
      </div>
    );
  }

  return null;
}
