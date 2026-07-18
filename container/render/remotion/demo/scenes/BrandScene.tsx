import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { DemoStage } from "../components/DemoStage";
import { DEMO_ASSETS } from "../demo-assets";
import {
  DEMO_BRAND_NAME,
  DEMO_SCENE_COPY,
} from "../demo-copy";
import { enterProgress, sceneOpacity } from "../demo-motion";
import { DEMO_THEME } from "../demo-theme";
import type { DemoFormat } from "../demo-timeline";

type BrandSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

type BrandWordmarkRevealProps = Readonly<{
  format: DemoFormat;
  drawProgress: number;
  fillProgress: number;
}>;

export const BrandWordmarkReveal = ({
  format,
  drawProgress,
  fillProgress,
}: BrandWordmarkRevealProps) => {
  const isLandscape = format === "landscape";
  const revealId = `brand-wordmark-reveal-${format}`;
  const entryProgress = interpolate(drawProgress, [0, 0.24], [0, 1], clamp);
  const letterProgress = interpolate(drawProgress, [0.18, 1], [0, 1], clamp);
  const entryPathLength = 240;

  return (
    <svg
      aria-label={`${DEMO_BRAND_NAME} wordmark`}
      role="img"
      viewBox="0 0 1100 300"
      style={{
        width: isLandscape ? 1100 : 850,
        height: isLandscape ? 300 : 232,
        flexShrink: 0,
        marginTop: isLandscape ? 0 : 80,
        overflow: "visible",
      }}
    >
      <defs>
        <clipPath id={revealId}>
          <rect
            x={190}
            y={18}
            width={interpolate(letterProgress, [0, 1], [0, 780], clamp)}
            height={248}
          />
        </clipPath>
      </defs>
      <path
        d="M18 142 C84 70 132 216 194 163"
        fill="none"
        stroke={DEMO_THEME.amber}
        strokeLinecap="round"
        strokeWidth={isLandscape ? 8 : 10}
        strokeDasharray={entryPathLength}
        strokeDashoffset={interpolate(
          entryProgress,
          [0, 1],
          [entryPathLength, 0],
          clamp,
        )}
      />
      <text
        x={560}
        y={218}
        clipPath={`url(#${revealId})`}
        fill="none"
        stroke={DEMO_THEME.amber}
        strokeLinejoin="round"
        strokeWidth={isLandscape ? 5 : 6}
        textAnchor="middle"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 188,
          fontWeight: 700,
          letterSpacing: "-14px",
        }}
      >
        {DEMO_BRAND_NAME}
      </text>
      <text
        x={560}
        y={218}
        clipPath={`url(#${revealId})`}
        fill={DEMO_THEME.ink}
        opacity={fillProgress}
        textAnchor="middle"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: 188,
          fontWeight: 700,
          letterSpacing: "-14px",
        }}
      >
        {DEMO_BRAND_NAME}
      </text>
    </svg>
  );
};

export const BrandScene = ({ format, durationInFrames }: BrandSceneProps) => {
  const frame = useCurrentFrame();
  const isLandscape = format === "landscape";
  const recedeProgress = enterProgress(frame, 0, isLandscape ? 38 : 28);
  const threadProgress = enterProgress(
    frame,
    isLandscape ? 18 : 14,
    isLandscape ? 46 : 34,
  );
  const wordmarkProgress = enterProgress(
    frame,
    isLandscape ? 60 : 46,
    isLandscape ? 18 : 16,
  );
  const copyProgress = enterProgress(
    frame,
    isLandscape ? 66 : 54,
    18,
  );

  return (
    <div style={{ width: "100%", height: "100%", opacity: sceneOpacity(frame, durationInFrames) }}>
      <DemoStage format={format}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            opacity: interpolate(recedeProgress, [0, 1], [0.34, 0], clamp),
            scale: interpolate(recedeProgress, [0, 1], [1.04, 0.78], clamp),
            filter: `blur(${interpolate(recedeProgress, [0, 1], [0, 8], clamp)}px)`,
          }}
        >
          <Img
            src={staticFile(DEMO_ASSETS.screens.publish)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: isLandscape ? "60% 52%" : "70% 55%",
            }}
          />
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            flex: 1,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: isLandscape ? 24 : 34,
          }}
        >
          <BrandWordmarkReveal
            format={format}
            drawProgress={threadProgress}
            fillProgress={wordmarkProgress}
          />

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: isLandscape ? 22 : 30,
              marginTop: isLandscape ? 36 : 58,
              opacity: copyProgress,
              translate: `0 ${interpolate(copyProgress, [0, 1], [24, 0], clamp)}px`,
            }}
          >
            <div
              style={{
                maxWidth: isLandscape ? 1100 : 860,
                color: DEMO_THEME.ink,
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: isLandscape ? 78 : 100,
                fontWeight: 700,
                letterSpacing: "-0.045em",
                lineHeight: 1,
                textAlign: "center",
              }}
            >
              {DEMO_SCENE_COPY.brand.tagline}
            </div>
            <div
              style={{
                color: "rgb(23 23 20 / 70%)",
                fontFamily: "Arial, sans-serif",
                fontSize: isLandscape ? 34 : 43,
                fontWeight: 700,
                letterSpacing: "0.025em",
              }}
            >
              {DEMO_SCENE_COPY.brand.url}
            </div>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
