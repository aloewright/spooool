import { interpolate, useCurrentFrame } from "remotion";
import { DemoCursor } from "../components/DemoCursor";
import { DemoStage } from "../components/DemoStage";
import { Headline } from "../components/Headline";
import { ProductFrame } from "../components/ProductFrame";
import { DEMO_ASSETS } from "../demo-assets";
import { DEMO_SCENE_COPY } from "../demo-copy";
import { enterProgress, toLogicalSceneFrame } from "../demo-motion";
import { DEMO_THEME } from "../demo-theme";
import type { DemoFormat } from "../demo-timeline";

type ShapeSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
  renderOffset: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const chapterCards = [
  ["01", "The Vanishing Ward"],
  ["02", "Ink at Midnight"],
  ["03", "The Last District"],
] as const;

export const ShapeScene = ({
  format,
  durationInFrames,
  renderOffset,
}: ShapeSceneProps) => {
  const frame = toLogicalSceneFrame(useCurrentFrame(), renderOffset);
  const isLandscape = format === "landscape";
  const surfaceProgress = enterProgress(frame, 2, 22);
  const cursorProgress = enterProgress(frame, isLandscape ? 58 : 48, 52);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <DemoStage format={format}>
        <div
          className="stack"
          style={{
            display: "flex",
            flex: 1,
            flexDirection: isLandscape ? "row" : "column",
            alignItems: isLandscape ? "center" : "stretch",
            justifyContent: "center",
            gap: isLandscape ? 66 : 42,
          }}
        >
          <div
            style={{
              position: "relative",
              order: 0,
              width: isLandscape ? 1220 : 920,
              height: isLandscape ? 760 : 1050,
              flexShrink: 0,
              alignSelf: isLandscape ? "flex-start" : "center",
            }}
          >
            <ProductFrame
              imagePath={DEMO_ASSETS.screens.outline}
              width={isLandscape ? 1220 : 920}
              height={isLandscape ? 760 : 1050}
              objectPosition={isLandscape ? "55% 46%" : "67% 42%"}
              motion={{
                opacity: surfaceProgress,
                scale: interpolate(surfaceProgress, [0, 1], [0.96, 1], clamp),
                translateX: isLandscape
                  ? interpolate(surfaceProgress, [0, 1], [-80, 0], clamp)
                  : 0,
                translateY: isLandscape
                  ? 0
                  : interpolate(surfaceProgress, [0, 1], [-55, 0], clamp),
              }}
            />

            <div
              className="stack"
              style={{
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                left: isLandscape ? 58 : 46,
                right: isLandscape ? 58 : 46,
                bottom: isLandscape ? 42 : 48,
                gap: isLandscape ? 12 : 16,
              }}
            >
              {chapterCards.map(([number, title], index) => {
                const cardProgress = enterProgress(
                  frame,
                  (isLandscape ? 28 : 24) + index * 10,
                  22,
                );
                return (
                  <div
                    key={number}
                    style={{
                      display: "grid",
                      gridTemplateColumns: isLandscape ? "62px 1fr 160px" : "84px 1fr",
                      alignItems: "center",
                      gap: 18,
                      minHeight: isLandscape ? 62 : 82,
                      padding: isLandscape ? "8px 22px" : "12px 24px",
                      border: "2px solid rgb(23 23 20 / 12%)",
                      borderRadius: 16,
                      boxSizing: "border-box",
                      backgroundColor: "rgb(255 255 255 / 95%)",
                      boxShadow: "0 12px 30px rgb(23 23 20 / 13%)",
                      color: DEMO_THEME.ink,
                      opacity: cardProgress,
                      translate: `${interpolate(cardProgress, [0, 1], [isLandscape ? 180 : -100, 0], clamp)}px 0`,
                    }}
                  >
                    <span
                      style={{
                        color: DEMO_THEME.amber,
                        fontFamily: "Arial, sans-serif",
                        fontSize: isLandscape ? 22 : 28,
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                      }}
                    >
                      {number}
                    </span>
                    <span
                      style={{
                        fontFamily: "Georgia, 'Times New Roman', serif",
                        fontSize: isLandscape ? 29 : 38,
                        fontWeight: 700,
                      }}
                    >
                      {title}
                    </span>
                    {isLandscape ? (
                      <span
                        style={{
                          color: "rgb(23 23 20 / 52%)",
                          fontFamily: "Arial, sans-serif",
                          fontSize: 20,
                          textAlign: "right",
                        }}
                      >
                        Scene ready
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <DemoCursor
              x={interpolate(cursorProgress, [0, 1], isLandscape ? [980, 680] : [760, 520], clamp)}
              y={interpolate(cursorProgress, [0, 1], isLandscape ? [200, 550] : [210, 760], clamp)}
              scale={isLandscape ? 0.88 : 1.1}
              opacity={interpolate(frame, [30, 42, durationInFrames - 18, durationInFrames - 6], [0, 1, 1, 0], clamp)}
            />
          </div>

          <div
            className="stack"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              order: isLandscape ? 1 : -1,
              width: isLandscape ? 470 : "100%",
              minHeight: isLandscape ? 760 : 220,
              flexShrink: 0,
            }}
          >
            <Headline
              opacity={enterProgress(frame, 10, 18)}
              translateY={interpolate(frame, [10, 28], [30, 0], clamp)}
              size={isLandscape ? 108 : 126}
              maxWidth={isLandscape ? 460 : 900}
              align={isLandscape ? "left" : "center"}
            >
              {DEMO_SCENE_COPY.shape}
            </Headline>
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
