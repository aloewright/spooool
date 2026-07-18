import type { CSSProperties } from "react";
import { DEMO_THEME } from "../demo-theme";

type HeadlineProps = Readonly<{
  children: string;
  opacity: number;
  translateY: number;
  size?: number;
  maxWidth?: number;
  align?: CSSProperties["textAlign"];
}>;

export const Headline = ({
  children,
  opacity,
  translateY,
  size = 96,
  maxWidth = 1100,
  align = "left",
}: HeadlineProps) => {
  return (
    <h1
      style={{
        margin: 0,
        maxWidth,
        color: DEMO_THEME.ink,
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: size,
        fontWeight: 700,
        lineHeight: 0.98,
        letterSpacing: "-0.055em",
        textAlign: align,
        opacity,
        translate: `0 ${translateY}px`,
      }}
    >
      {children}
    </h1>
  );
};
