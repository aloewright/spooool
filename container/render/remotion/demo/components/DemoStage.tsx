import type { CSSProperties, ReactNode } from "react";
import type { DemoFormat } from "../demo-timeline";
import { DEMO_THEME, getDemoSafeArea } from "../demo-theme";

type DemoStageProps = Readonly<{
  children: ReactNode;
  format: DemoFormat;
}>;

const stageStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  backgroundColor: DEMO_THEME.paper,
  backgroundImage: [
    "radial-gradient(circle at 18% 16%, rgb(255 255 255 / 58%) 0 1px, transparent 1.5px)",
    "radial-gradient(circle at 76% 68%, rgb(23 23 20 / 8%) 0 1px, transparent 1.5px)",
    "linear-gradient(135deg, #f8f5eb 0%, #f2efe5 46%, #e8e0cf 100%)",
  ].join(", "),
  backgroundSize: "17px 19px, 23px 29px, 100% 100%",
};

export const DemoStage = ({ children, format }: DemoStageProps) => {
  const safeArea = getDemoSafeArea(format);

  return (
    <div style={stageStyle}>
      <div
        className="stack"
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          paddingTop: safeArea.top,
          paddingRight: safeArea.right,
          paddingBottom: safeArea.bottom,
          paddingLeft: safeArea.left,
        }}
      >
        {children}
      </div>
    </div>
  );
};
