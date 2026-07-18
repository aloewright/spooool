import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { DemoStage } from "../components/DemoStage";
import { DEMO_ASSETS } from "../demo-assets";
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
    isLandscape ? 48 : 38,
    20,
  );
  const copyProgress = enterProgress(
    frame,
    isLandscape ? 66 : 54,
    18,
  );
  const pathLength = 820;

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
          <svg
            aria-hidden
            viewBox="0 0 900 250"
            style={{
              position: "absolute",
              top: isLandscape ? 210 : 460,
              width: isLandscape ? 900 : 850,
              height: isLandscape ? 250 : 236,
              overflow: "visible",
              opacity: threadProgress,
            }}
          >
            <path
              d="M38 142 C170 18 282 222 416 122 C538 31 602 33 688 118 C750 179 795 175 862 91"
              fill="none"
              stroke={DEMO_THEME.amber}
              strokeLinecap="round"
              strokeWidth={isLandscape ? 8 : 10}
              strokeDasharray={pathLength}
              strokeDashoffset={interpolate(threadProgress, [0, 1], [pathLength, 0], clamp)}
            />
          </svg>

          <div
            style={{
              position: "relative",
              marginTop: isLandscape ? 12 : 150,
              color: DEMO_THEME.ink,
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: isLandscape ? 180 : 190,
              fontWeight: 700,
              letterSpacing: "-0.075em",
              lineHeight: 0.9,
              opacity: wordmarkProgress,
              scale: interpolate(wordmarkProgress, [0, 1], [0.94, 1], clamp),
              translate: `0 ${interpolate(wordmarkProgress, [0, 1], [24, 0], clamp)}px`,
            }}
          >
            Spooool
          </div>

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
              Where ideas become stories.
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
              spooool.com/studio
            </div>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
