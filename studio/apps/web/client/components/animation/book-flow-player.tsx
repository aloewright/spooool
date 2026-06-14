import { Player } from "@remotion/player";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const STEPS = ["Outline", "Chapters", "Draft", "Full Book"] as const;

export default function BookFlowPlayer() {
  return (
    <Player
      component={BookFlowComposition}
      durationInFrames={150}
      compositionWidth={640}
      compositionHeight={190}
      fps={30}
      loop
      autoPlay
      controls={false}
      style={{ width: "100%", height: "auto" }}
    />
  );
}

function BookFlowComposition() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 28, stiffness: 90 } });
  const lineWidth = interpolate(progress, [0, 1], [0, 468], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, hsl(0 0% 100%) 0%, hsl(210 20% 97%) 100%)",
        color: "hsl(222 47% 11%)",
        fontFamily: "Inter, ui-sans-serif, system-ui",
        padding: 28,
      }}
    >
      <div
        style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.8, textTransform: "uppercase" }}
      >
        Book flow
      </div>
      <div style={{ position: "relative", marginTop: 36, height: 78 }}>
        <div
          style={{
            position: "absolute",
            top: 27,
            left: 56,
            width: 468,
            height: 2,
            background: "hsl(214 32% 86%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 27,
            left: 56,
            width: lineWidth,
            height: 2,
            background: "hsl(173 80% 32%)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {STEPS.map((step, index) => {
            const appear = spring({
              frame: frame - index * 20,
              fps,
              config: { damping: 24, stiffness: 120 },
            });
            return (
              <div
                key={step}
                style={{
                  width: 112,
                  transform: `translateY(${interpolate(appear, [0, 1], [10, 0])}px)`,
                  opacity: interpolate(appear, [0, 1], [0.35, 1]),
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    margin: "0 auto",
                    borderRadius: 14,
                    display: "grid",
                    placeItems: "center",
                    background: appear > 0.65 ? "hsl(173 80% 32%)" : "hsl(0 0% 100%)",
                    color: appear > 0.65 ? "white" : "hsl(215 16% 47%)",
                    border: "1px solid hsl(214 32% 86%)",
                    boxShadow: "0 8px 20px hsl(215 25% 20% / 0.10)",
                    fontWeight: 800,
                  }}
                >
                  {index + 1}
                </div>
                <div style={{ marginTop: 10, fontSize: 15, fontWeight: 700 }}>{step}</div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}
