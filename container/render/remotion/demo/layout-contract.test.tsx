import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("remotion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("remotion")>()),
  useCurrentFrame: () => 0,
}));

import { DemoCursor } from "./components/DemoCursor";
import { DemoStage } from "./components/DemoStage";
import { ProductFrame } from "./components/ProductFrame";
import { LANDSCAPE_SAFE_AREA } from "./demo-theme";
import { BrandScene } from "./scenes/BrandScene";
import { ComposeScene } from "./scenes/ComposeScene";
import { PublishScene } from "./scenes/PublishScene";
import { RefineScene } from "./scenes/RefineScene";
import { ShapeScene } from "./scenes/ShapeScene";
import { SparkScene } from "./scenes/SparkScene";

const collectFlexElements = (node: ReactNode): ReactElement[] => {
  if (Array.isArray(node)) return node.flatMap(collectFlexElements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];

  const element = node as ReactElement<{
    children?: ReactNode;
    className?: string;
    style?: { display?: string };
  }>;
  const nested = collectFlexElements(element.props.children);
  return element.props.style?.display === "flex" ? [element, ...nested] : nested;
};

const hasStackClass = (element: ReactElement<{ className?: string }>) =>
  element.props.className?.split(/\s+/).includes("stack") === true;

describe("demo layout contract", () => {
  it("anchors cursor translation to the containing block origin", () => {
    const cursor = DemoCursor({ x: 120, y: 80, scale: 1, opacity: 1 }) as ReactElement<{
      style: Record<string, unknown>;
    }>;

    expect(cursor.props.style).toMatchObject({ position: "absolute", top: 0, left: 0 });
  });

  it("uses the exact 120px landscape horizontal safe area", () => {
    expect(LANDSCAPE_SAFE_AREA).toEqual({ top: 100, right: 120, bottom: 100, left: 120 });
  });

  it.each([
    ["DemoStage", DemoStage({ children: null, format: "landscape" })],
    [
      "ProductFrame",
      ProductFrame({
        imagePath: "demo/screens/studio-home.png",
        width: 400,
        height: 300,
        motion: { opacity: 1, scale: 1, translateX: 0, translateY: 0 },
      }),
    ],
    ["BrandScene", BrandScene({ format: "landscape", durationInFrames: 120, renderOffset: 0 })],
    ["ComposeScene", ComposeScene({ format: "landscape", durationInFrames: 150, renderOffset: 0 })],
    ["PublishScene", PublishScene({ format: "landscape", durationInFrames: 150, renderOffset: 0 })],
    ["RefineScene", RefineScene({ format: "landscape", durationInFrames: 210, renderOffset: 0 })],
    ["ShapeScene", ShapeScene({ format: "landscape", durationInFrames: 180, renderOffset: 0 })],
    ["SparkScene", SparkScene({ format: "landscape", durationInFrames: 90, renderOffset: 0 })],
  ] as const)("routes every %s flex container through the base stack class", (_name, tree) => {
    const flexElements = collectFlexElements(tree);

    expect(flexElements.length).toBeGreaterThan(0);
    expect(flexElements.every(hasStackClass)).toBe(true);
  });
});
