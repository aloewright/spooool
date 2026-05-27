/**
 * SpoooolVideo — primary composition for headless renders.
 *
 * Accepts the inputProps shape the render harness passes:
 *   { takes, title?, brand?, sceneOrder?, layouts? }
 *
 * Each entry in `takes` is a staticFile key resolved to a <Video> clip.
 * Clips are laid out sequentially; actual motion/transitions will be wired
 * in Task 12 once the full scene pipeline is connected.
 */

import React from "react";
import { AbsoluteFill, Sequence, staticFile, Video } from "remotion";

export type SpoooolVideoProps = {
  takes: string[];
  title?: string;
  brand?: {
    color?: string;
    logoUrl?: string;
  };
  sceneOrder?: string[];
  layouts?: Record<string, unknown>;
};

export const FRAMES_PER_TAKE = 300; // 10 s @ 30 fps — placeholder until Task 12 wires real durations

export const SpoooolVideo: React.FC<SpoooolVideoProps> = ({
  takes,
  title,
  brand,
}) => {
  const accentColor = brand?.color ?? "#0a84ff";

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {takes.map((take, i) => (
        <Sequence
          key={take}
          from={i * FRAMES_PER_TAKE}
          durationInFrames={FRAMES_PER_TAKE}
          name={`take-${i}`}
        >
          <AbsoluteFill>
            <Video
              src={staticFile(take)}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
            {/* Title overlay on first take */}
            {i === 0 && title ? (
              <AbsoluteFill
                style={{
                  justifyContent: "flex-end",
                  alignItems: "flex-start",
                  padding: 48,
                }}
              >
                <span
                  style={{
                    color: "#fff",
                    fontSize: 48,
                    fontWeight: 700,
                    fontFamily: "sans-serif",
                    textShadow: "0 2px 8px rgba(0,0,0,0.7)",
                    borderLeft: `6px solid ${accentColor}`,
                    paddingLeft: 16,
                  }}
                >
                  {title}
                </span>
              </AbsoluteFill>
            ) : null}
          </AbsoluteFill>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
