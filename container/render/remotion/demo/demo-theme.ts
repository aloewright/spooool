import type { DemoFormat } from "./demo-timeline";

export const DEMO_THEME = {
  ink: "#171714",
  paper: "#F2EFE5",
  cream: "#E8E0CF",
  amber: "#D58B3D",
  sage: "#82937A",
  white: "#FFFFFF",
} as const;

export type DemoSafeArea = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export const LANDSCAPE_SAFE_AREA: DemoSafeArea = {
  top: 100,
  right: 80,
  bottom: 100,
  left: 80,
};

export const VERTICAL_SAFE_AREA: DemoSafeArea = {
  top: 120,
  right: 80,
  bottom: 120,
  left: 80,
};

export const getDemoSafeArea = (format: DemoFormat): DemoSafeArea =>
  format === "landscape" ? LANDSCAPE_SAFE_AREA : VERTICAL_SAFE_AREA;
