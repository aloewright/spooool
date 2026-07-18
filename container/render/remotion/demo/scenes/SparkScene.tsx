import { interpolate, useCurrentFrame } from "remotion";
import { DemoStage } from "../components/DemoStage";
import { Headline } from "../components/Headline";
import { ProductFrame } from "../components/ProductFrame";
import { DEMO_ASSETS } from "../demo-assets";
import { DEMO_SCENE_COPY } from "../demo-copy";
import { enterProgress } from "../demo-motion";
import { DEMO_THEME } from "../demo-theme";
import type { DemoFormat } from "../demo-timeline";

type SparkSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const formatCards = ["Book", "Blog", "Script"] as const;

export const SparkScene = ({ format }: SparkSceneProps) => {
  const frame = useCurrentFrame();
  const isLandscape = format === "landscape";
  const homeStart = isLandscape ? 28 : 18;
  const homeProgress = enterProgress(frame, homeStart, isLandscape ? 24 : 18);
  const ideaOut = interpolate(
    frame,
    [homeStart - 5, homeStart + 14],
    [1, 0],
    clamp,
  );
  const caretOpacity = interpolate(
    frame % 18,
    [0, 8, 9, 17],
    [1, 1, 0, 0],
    clamp,
  );

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
            gap: isLandscape ? 92 : 70,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              flexShrink: 0,
              opacity: ideaOut,
              translate: `0 ${interpolate(frame, [0, homeStart], [18, 0], clamp)}px`,
            }}
          >
            <Headline
              opacity={enterProgress(frame, 2, 18)}
              translateY={0}
              size={isLandscape ? 120 : 144}
              maxWidth={isLandscape ? 520 : 880}
              align={isLandscape ? "left" : "center"}
            >
              {DEMO_SCENE_COPY.spark}
            </Headline>
            <span
              style={{
                width: isLandscape ? 5 : 6,
                height: isLandscape ? 112 : 132,
                marginLeft: isLandscape ? 18 : 22,
                backgroundColor: DEMO_THEME.amber,
                opacity: caretOpacity,
              }}
            />
          </div>

          <div
            style={{
              position: isLandscape ? "relative" : "absolute",
              right: isLandscape ? undefined : 80,
              bottom: isLandscape ? undefined : 150,
              width: isLandscape ? 1020 : 920,
              height: isLandscape ? 660 : 1050,
              opacity: homeProgress,
              scale: interpolate(homeProgress, [0, 1], [0.94, 1], clamp),
              translate: isLandscape
                ? `${interpolate(homeProgress, [0, 1], [90, 0], clamp)}px 0`
                : `0 ${interpolate(homeProgress, [0, 1], [100, 0], clamp)}px`,
            }}
          >
            <ProductFrame
              imagePath={DEMO_ASSETS.screens.home}
              width={isLandscape ? 1020 : 920}
              height={isLandscape ? 660 : 1050}
              objectPosition={isLandscape ? "42% 20%" : "48% 18%"}
              motion={{ opacity: 1, scale: 1, translateX: 0, translateY: 0 }}
            />
            <div
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: isLandscape ? "row" : "column",
                right: isLandscape ? 44 : 54,
                bottom: isLandscape ? 46 : 54,
                gap: isLandscape ? 16 : 18,
              }}
            >
              {formatCards.map((label, index) => {
                const cardProgress = enterProgress(
                  frame,
                  homeStart + 10 + index * 5,
                  14,
                );
                return (
                  <div
                    key={label}
                    style={{
                      width: isLandscape ? 158 : 300,
                      padding: isLandscape ? "20px 24px" : "24px 30px",
                      border: "2px solid rgb(23 23 20 / 12%)",
                      borderRadius: 18,
                      boxSizing: "border-box",
                      backgroundColor: "rgb(255 255 255 / 94%)",
                      boxShadow: "0 14px 30px rgb(23 23 20 / 14%)",
                      color: DEMO_THEME.ink,
                      fontFamily: "Arial, sans-serif",
                      fontSize: isLandscape ? 28 : 36,
                      fontWeight: 700,
                      opacity: cardProgress,
                      rotate: `${interpolate(cardProgress, [0, 1], [(index - 1) * 8, 0], clamp)}deg`,
                      translate: `0 ${interpolate(cardProgress, [0, 1], [45 + index * 10, 0], clamp)}px`,
                    }}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
