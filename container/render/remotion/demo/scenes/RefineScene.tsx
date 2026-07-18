import { interpolate, useCurrentFrame } from "remotion";
import { DemoStage } from "../components/DemoStage";
import { Headline } from "../components/Headline";
import { ProductFrame } from "../components/ProductFrame";
import { DEMO_ASSETS } from "../demo-assets";
import { DEMO_SCENE_COPY } from "../demo-copy";
import { enterProgress, sceneOpacity } from "../demo-motion";
import { DEMO_THEME } from "../demo-theme";
import type { DemoFormat } from "../demo-timeline";

type RefineSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const beforeExcerpt = "The Lantern Ward has vanished from the page.";
const afterExcerpt = "The ward vanished, leaving the page bright and bare.";

export const RefineScene = ({
  format,
  durationInFrames,
}: RefineSceneProps) => {
  const frame = useCurrentFrame();
  const isLandscape = format === "landscape";
  const surfaceProgress = enterProgress(frame, 2, 20);
  const cueProgress = enterProgress(frame, isLandscape ? 42 : 34, 18);
  const refineProgress = enterProgress(
    frame,
    isLandscape ? 78 : 62,
    12,
  );

  return (
    <div style={{ width: "100%", height: "100%", opacity: sceneOpacity(frame, durationInFrames) }}>
      <DemoStage format={format}>
        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: isLandscape ? 34 : 48,
          }}
        >
          <Headline
            opacity={enterProgress(frame, 8, 18)}
            translateY={interpolate(frame, [8, 26], [24, 0], clamp)}
            size={isLandscape ? 100 : 116}
            maxWidth={isLandscape ? 1500 : 900}
            align="center"
          >
            {DEMO_SCENE_COPY.refine}
          </Headline>

          <div style={{ position: "relative", width: isLandscape ? 1600 : 920, height: isLandscape ? 700 : 1210 }}>
            <ProductFrame
              imagePath={DEMO_ASSETS.screens.editor}
              width={isLandscape ? 1600 : 920}
              height={isLandscape ? 700 : 1210}
              objectPosition={isLandscape ? "55% 41%" : "61% 43%"}
              motion={{
                opacity: surfaceProgress,
                scale: interpolate(surfaceProgress, [0, 1], [0.97, 1], clamp),
                translateX: 0,
                translateY: interpolate(surfaceProgress, [0, 1], [55, 0], clamp),
              }}
            />

            <div
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                left: isLandscape ? 100 : 42,
                right: isLandscape ? 520 : 42,
                bottom: isLandscape ? 54 : 88,
                minHeight: isLandscape ? 176 : 285,
                padding: isLandscape ? "28px 34px" : "36px 40px",
                border: "2px solid rgb(255 255 255 / 14%)",
                borderRadius: 22,
                boxSizing: "border-box",
                backgroundColor: "rgb(23 23 20 / 96%)",
                boxShadow: "0 24px 60px rgb(0 0 0 / 32%)",
                opacity: enterProgress(frame, isLandscape ? 30 : 25, 16),
              }}
            >
              <div
                style={{
                  marginBottom: isLandscape ? 18 : 24,
                  color: "rgb(255 255 255 / 54%)",
                  fontFamily: "Arial, sans-serif",
                  fontSize: isLandscape ? 20 : 27,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                Selected passage
              </div>
              <div
                style={{
                  position: "relative",
                  minHeight: isLandscape ? 64 : 128,
                  color: DEMO_THEME.white,
                  fontFamily: "Georgia, 'Times New Roman', serif",
                  fontSize: isLandscape ? 40 : 49,
                  lineHeight: 1.22,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    overflow: "hidden",
                    clipPath: `inset(0 0 0 ${interpolate(refineProgress, [0, 1], [0, 100], clamp)}%)`,
                  }}
                >
                  {beforeExcerpt}
                </span>
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    overflow: "hidden",
                    clipPath: `inset(0 ${interpolate(refineProgress, [0, 1], [100, 0], clamp)}% 0 0)`,
                    color: DEMO_THEME.white,
                  }}
                >
                  {afterExcerpt}
                </span>
              </div>
              <div
                style={{
                  width: `${interpolate(refineProgress, [0, 1], [0, 100], clamp)}%`,
                  height: 4,
                  marginTop: 18,
                  borderRadius: 2,
                  backgroundColor: DEMO_THEME.amber,
                }}
              />
            </div>

            <div
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                right: isLandscape ? 54 : 42,
                top: isLandscape ? 92 : 80,
                width: isLandscape ? 410 : 570,
                padding: isLandscape ? "26px 30px" : "32px 38px",
                borderRadius: 20,
                boxSizing: "border-box",
                backgroundColor: DEMO_THEME.cream,
                boxShadow: "0 18px 48px rgb(0 0 0 / 26%)",
                opacity: cueProgress,
                translate: `${interpolate(cueProgress, [0, 1], [60, 0], clamp)}px 0`,
              }}
            >
              <span
                style={{
                  color: DEMO_THEME.amber,
                  fontFamily: "Arial, sans-serif",
                  fontSize: isLandscape ? 19 : 26,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Editorial assistant
              </span>
              <span
                style={{
                  marginTop: 12,
                  color: DEMO_THEME.ink,
                  fontFamily: "Georgia, 'Times New Roman', serif",
                  fontSize: isLandscape ? 31 : 40,
                  fontWeight: 700,
                  lineHeight: 1.18,
                }}
              >
                Tighten the image.
              </span>
            </div>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
