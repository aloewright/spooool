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

type ComposeSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
  renderOffset: number;
}>;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const typedLogline =
  "A mapmaker must redraw a city that changes each night before its last district disappears.";

export const ComposeScene = ({
  format,
  durationInFrames,
  renderOffset,
}: ComposeSceneProps) => {
  const frame = toLogicalSceneFrame(useCurrentFrame(), renderOffset);
  const isLandscape = format === "landscape";
  const frameProgress = enterProgress(frame, 3, 20);
  const typeProgress = enterProgress(
    frame,
    isLandscape ? 42 : 32,
    isLandscape ? 52 : 42,
  );
  const visibleCharacters = Math.floor(typedLogline.length * typeProgress);
  const cursorProgress = enterProgress(frame, isLandscape ? 25 : 20, 34);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <DemoStage format={format}>
        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: isLandscape ? "row" : "column",
            alignItems: isLandscape ? "center" : "stretch",
            justifyContent: "center",
            gap: isLandscape ? 86 : 54,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              width: isLandscape ? 520 : "100%",
              minHeight: isLandscape ? 640 : 250,
              flexShrink: 0,
            }}
          >
            <Headline
              opacity={enterProgress(frame, 8, 18)}
              translateY={interpolate(frame, [8, 26], [28, 0], clamp)}
              size={isLandscape ? 106 : 126}
              maxWidth={isLandscape ? 500 : 900}
              align={isLandscape ? "left" : "center"}
            >
              {DEMO_SCENE_COPY.compose}
            </Headline>
            <div
              style={{
                width: interpolate(frame, [20, 70], [0, isLandscape ? 320 : 520], clamp),
                height: 6,
                marginTop: isLandscape ? 42 : 36,
                alignSelf: isLandscape ? "flex-start" : "center",
                borderRadius: 3,
                backgroundColor: DEMO_THEME.amber,
              }}
            />
          </div>

          <div style={{ position: "relative", width: isLandscape ? 1100 : 920, height: isLandscape ? 720 : 1120 }}>
            <ProductFrame
              imagePath={DEMO_ASSETS.screens.compose}
              width={isLandscape ? 1100 : 920}
              height={isLandscape ? 720 : 1120}
              objectPosition={isLandscape ? "58% 48%" : "57% 43%"}
              motion={{
                opacity: frameProgress,
                scale: interpolate(frameProgress, [0, 1], [0.96, 1], clamp),
                translateX: isLandscape
                  ? interpolate(frameProgress, [0, 1], [80, 0], clamp)
                  : 0,
                translateY: isLandscape
                  ? 0
                  : interpolate(frameProgress, [0, 1], [70, 0], clamp),
              }}
            />

            <div
              style={{
                position: "absolute",
                left: isLandscape ? 110 : 54,
                right: isLandscape ? 70 : 54,
                bottom: isLandscape ? 62 : 82,
                minHeight: isLandscape ? 134 : 230,
                padding: isLandscape ? "24px 32px" : "34px 38px",
                overflow: "hidden",
                border: "2px solid rgb(23 23 20 / 13%)",
                borderRadius: 20,
                boxSizing: "border-box",
                backgroundColor: "rgb(242 239 229 / 97%)",
                boxShadow: "0 18px 50px rgb(23 23 20 / 16%)",
                opacity: enterProgress(frame, isLandscape ? 34 : 25, 14),
              }}
            >
              <div
                style={{
                  marginBottom: 12,
                  color: "rgb(23 23 20 / 56%)",
                  fontFamily: "Arial, sans-serif",
                  fontSize: isLandscape ? 22 : 28,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Logline
              </div>
              <div
                style={{
                  color: DEMO_THEME.ink,
                  fontFamily: "Georgia, 'Times New Roman', serif",
                  fontSize: isLandscape ? 33 : 43,
                  lineHeight: 1.22,
                }}
              >
                {typedLogline.slice(0, visibleCharacters)}
                <span style={{ color: DEMO_THEME.amber }}>|</span>
              </div>
            </div>

            <DemoCursor
              x={interpolate(
                cursorProgress,
                [0, 1],
                isLandscape ? [950, 770] : [760, 610],
                clamp,
              )}
              y={interpolate(
                cursorProgress,
                [0, 1],
                isLandscape ? [170, 525] : [250, 795],
                clamp,
              )}
              scale={isLandscape ? 0.9 : 1.15}
              opacity={interpolate(frame, [16, 25, durationInFrames - 20, durationInFrames - 8], [0, 1, 1, 0], clamp)}
            />
          </div>
        </div>
      </DemoStage>
    </div>
  );
};
