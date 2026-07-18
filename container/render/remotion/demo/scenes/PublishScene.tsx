import { interpolate, useCurrentFrame } from "remotion";
import { DemoStage } from "../components/DemoStage";
import { Headline } from "../components/Headline";
import { ProductFrame } from "../components/ProductFrame";
import { DEMO_ASSETS } from "../demo-assets";
import { DEMO_SCENE_COPY } from "../demo-copy";
import { enterProgress } from "../demo-motion";
import { DEMO_THEME } from "../demo-theme";
import type { DemoFormat } from "../demo-timeline";

type PublishSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

export const PublishScene = ({ format }: PublishSceneProps) => {
  const frame = useCurrentFrame();
  const isLandscape = format === "landscape";
  const surfaceProgress = enterProgress(frame, 2, 18);
  const pageProgress = enterProgress(
    frame,
    isLandscape ? 52 : 35,
    isLandscape ? 42 : 30,
  );
  const chipProgress = enterProgress(
    frame,
    isLandscape ? 98 : 55,
    isLandscape ? 16 : 10,
  );
  const surfaceWidth = isLandscape ? 1180 : 920;
  const surfaceHeight = isLandscape ? 760 : 1160;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <DemoStage format={format}>
        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: isLandscape ? "row" : "column",
            alignItems: "center",
            justifyContent: "center",
            gap: isLandscape ? 72 : 50,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              width: isLandscape ? 500 : "100%",
              flexShrink: 0,
            }}
          >
            <Headline
              opacity={enterProgress(frame, 8, 18)}
              translateY={interpolate(frame, [8, 26], [26, 0], clamp)}
              size={isLandscape ? 108 : 126}
              maxWidth={isLandscape ? 500 : 900}
              align={isLandscape ? "left" : "center"}
            >
              {DEMO_SCENE_COPY.publish}
            </Headline>
          </div>

          <div style={{ position: "relative", width: surfaceWidth, height: surfaceHeight }}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: interpolate(pageProgress, [0, 0.8, 1], [1, 0.25, 0], clamp),
              }}
            >
              <ProductFrame
                imagePath={DEMO_ASSETS.screens.book}
                width={surfaceWidth}
                height={surfaceHeight}
                objectPosition={isLandscape ? "59% 49%" : "72% 52%"}
                motion={{
                  opacity: surfaceProgress,
                  scale: interpolate(surfaceProgress, [0, 1], [0.97, 1], clamp),
                  translateX: isLandscape
                    ? interpolate(surfaceProgress, [0, 1], [70, 0], clamp)
                    : 0,
                  translateY: isLandscape
                    ? 0
                    : interpolate(surfaceProgress, [0, 1], [70, 0], clamp),
                }}
              />
            </div>

            <div
              style={{
                position: "absolute",
                inset: 0,
                overflow: "hidden",
                clipPath: `inset(0 ${interpolate(pageProgress, [0, 1], [100, 0], clamp)}% 0 0 round 28px)`,
                opacity: pageProgress,
              }}
            >
              <ProductFrame
                imagePath={DEMO_ASSETS.screens.publish}
                width={surfaceWidth}
                height={surfaceHeight}
                objectPosition={isLandscape ? "64% 54%" : "71% 58%"}
                motion={{ opacity: 1, scale: 1, translateX: 0, translateY: 0 }}
              />
            </div>

            <div
              style={{
                position: "absolute",
                display: "flex",
                alignItems: "center",
                right: isLandscape ? 42 : 34,
                bottom: isLandscape ? 42 : 48,
                gap: 14,
                padding: isLandscape ? "18px 24px" : "24px 30px",
                border: "2px solid rgb(23 23 20 / 12%)",
                borderRadius: 18,
                backgroundColor: DEMO_THEME.white,
                boxShadow: "0 16px 42px rgb(23 23 20 / 20%)",
                color: DEMO_THEME.ink,
                fontFamily: "Arial, sans-serif",
                fontSize: isLandscape ? 26 : 34,
                fontWeight: 800,
                opacity: chipProgress,
                scale: interpolate(chipProgress, [0, 1], [0.9, 1], clamp),
                translate: `0 ${interpolate(chipProgress, [0, 1], [28, 0], clamp)}px`,
              }}
            >
              <span
                style={{
                  display: "grid",
                  width: isLandscape ? 34 : 44,
                  height: isLandscape ? 34 : 44,
                  placeItems: "center",
                  borderRadius: "50%",
                  backgroundColor: DEMO_THEME.sage,
                  color: DEMO_THEME.white,
                }}
              >
                ✓
              </span>
              Export completed
            </div>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
